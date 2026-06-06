import { execSync, exec } from "child_process";
import fs from "fs";
import path from "path";
import { config } from "../config";

// ---------- MIME types for audio upload ----------
const MIME_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".webm": "audio/webm",
  ".mp4": "audio/mp4",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".aiff": "audio/aiff",
  ".flac": "audio/flac",
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

// ---------- Semaphore: only one local transcription at a time ----------
interface QueueItem {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  run: () => Promise<string>;
}
let transcriptionQueue: QueueItem[] = [];
let transcriptionBusy = false;

async function runQueued(): Promise<void> {
  if (transcriptionBusy || transcriptionQueue.length === 0) return;
  transcriptionBusy = true;
  const next = transcriptionQueue.shift()!;
  try {
    const result = await next.run();
    next.resolve(result);
  } catch (err) {
    next.reject(err as Error);
  } finally {
    transcriptionBusy = false;
    runQueued();
  }
}

function enqueueTranscription(run: () => Promise<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    transcriptionQueue.push({ resolve, reject, run });
    runQueued();
  });
}

// ---------- Provider detection ----------

/**
 * Check if faster-whisper is available in the system Python environment.
 */
export function isWhisperAvailable(): boolean {
  try {
    execSync('python3 -c "import faster_whisper; print(faster_whisper.__version__)"', {
      stdio: "pipe",
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Determine which STT provider should be used.
 * Priority:
 * 1. STT_PROVIDER=deepgram + DEEPGRAM_API_KEY → Deepgram Nova-2 (cloud)
 * 2. STT_PROVIDER=local + Python faster-whisper → local
 * 3. (Fallback) faster-whisper not found but DEEPGRAM_API_KEY is set → Deepgram
 */
function resolveProvider(): "local" | "deepgram" {
  const preferred = config.stt.provider;

  if (preferred === "deepgram") {
    if (config.stt.deepgram.apiKey) return "deepgram";
    throw new Error(
      "STT provider is set to 'deepgram' but DEEPGRAM_API_KEY is not configured."
    );
  }

  // Default / "local" path
  if (isWhisperAvailable()) return "local";

  // Local not available — try Deepgram as fallback
  if (config.stt.deepgram.apiKey) {
    console.warn(
      "⚠ faster-whisper not found, falling back to Deepgram Nova-2 cloud API."
    );
    return "deepgram";
  }

  throw new Error(
    "No speech-to-text provider available. " +
    "Install faster-whisper (pip install faster-whisper) " +
    "or set STT_PROVIDER=deepgram and DEEPGRAM_API_KEY in .env"
  );
}

// ---------- Local transcriber (faster-whisper) ----------

async function transcribeLocal(
  audioPath: string,
  modelSize: string,
  language: string,
  contextWords: string
): Promise<string> {
  const scriptPath = path.resolve(__dirname, "..", "..", "scripts", "transcribe.py");

  return enqueueTranscription(() => {
    return new Promise<string>((resolve, reject) => {
      const child = exec(
        `python3 "${scriptPath}" "${audioPath}" "${modelSize}" "${language}" "${contextWords}"`,
        {
          timeout: 120 * 60 * 1000, // 2 hour timeout
          maxBuffer: 50 * 1024 * 1024, // 50MB
        },
        (error, stdout, stderr) => {
          if (error) {
            if (!stdout?.trim()) {
              reject(new Error(`Transcription failed: ${stderr || error.message}`));
              return;
            }
          }
          resolve(stdout.trim());
        }
      );
    });
  });
}

// ---------- Cloud transcriber (Deepgram Nova-2) ----------

interface DeepgramWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
  speaker?: number;
}

interface DeepgramAlternative {
  transcript: string;
  confidence: number;
  words: DeepgramWord[];
  paragraphs?: {
    paragraphs: Array<{
      sentences: Array<{ text: string; start: number; end: number }>;
      start: number;
      end: number;
    }>;
  };
}

interface DeepgramChannel {
  alternatives: DeepgramAlternative[];
}

interface DeepgramResult {
  channels: DeepgramChannel[];
}

interface DeepgramResponse {
  results?: DeepgramResult;
  metadata?: {
    duration: number;
  };
  error?: string;
}

async function transcribeDeepgram(audioPath: string, language?: string): Promise<string> {
  const apiKey = config.stt.deepgram.apiKey;
  const model = config.stt.deepgram.model;
  const lang = language || config.whisper.language;

  // Build query params
  const params = new URLSearchParams({
    model,
    smart_format: "true",
    punctuate: "true",
    diarize: "true",
    utterances: "true",
  });
  if (lang && lang !== "auto") {
    params.set("language", lang);
  }

  console.log(`  → Sending to Deepgram API (model: ${model})...`);

  const audioBuffer = fs.readFileSync(audioPath);
  const mimeType = getMimeType(audioPath);

  const response = await fetch(
    `https://api.deepgram.com/v1/listen?${params.toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": mimeType,
      },
      body: audioBuffer,
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Deepgram API error (${response.status}): ${errorText.substring(0, 500)}`
    );
  }

  const data = (await response.json()) as DeepgramResponse;

  if (data.error) {
    throw new Error(`Deepgram error: ${data.error}`);
  }

  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();

  if (!transcript) {
    throw new Error("Deepgram returned empty transcript");
  }

  return transcript;
}

// ---------- Public API ----------

/**
 * Transcribe an audio file using the configured STT provider.
 *
 * Provider priority:
 * 1. STT_PROVIDER=deepgram + DEEPGRAM_API_KEY → Deepgram Nova-2 (cloud)
 * 2. STT_PROVIDER=local + Python faster-whisper → local (CPU, queued)
 * 3. (Fallback) faster-whisper not found but DEEPGRAM_API_KEY is set → Deepgram
 *
 * @param audioPath - Absolute path to the audio file
 * @param modelSize - Whisper model size (local only: tiny/base/small/medium/large-v3)
 * @param language - Language code (ISO 639-1), defaults to config or "en"
 * @param contextWords - Domain terms (local only, used as initial_prompt)
 * @returns The transcribed text
 */
export async function transcribeAudio(
  audioPath: string,
  modelSize: string = config.whisper.modelSize,
  language?: string,
  contextWords?: string
): Promise<string> {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const provider = resolveProvider();
  const lang = language || config.whisper.language;
  const context = contextWords || config.whisper.contextWords || "";

  console.log(`  → STT provider: ${provider}`);

  if (provider === "deepgram") {
    // Cloud — no concurrent queuing needed (handled by Deepgram infra)
    const fileSizeMB = fs.statSync(audioPath).size / (1024 * 1024);
    console.log(`  → Audio file: ${fileSizeMB.toFixed(1)} MB`);
    return transcribeDeepgram(audioPath, lang);
  }

  // Local — queued to avoid OOM
  return transcribeLocal(audioPath, modelSize, lang, context);
}
