import { execSync, exec } from "child_process";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { config } from "../config";

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
 * - If config says "openai" and an API key is set → "openai"
 * - If config says "local" (or not set) and Python + faster-whisper is available → "local"
 * - Falls back to "openai" if available, otherwise throws
 */
function resolveProvider(): "local" | "openai" {
  const preferred = config.stt.provider;

  if (preferred === "openai") {
    if (config.stt.openai.apiKey) return "openai";
    throw new Error(
      "STT provider is set to 'openai' but OPENAI_API_KEY is not configured."
    );
  }

  // Default / "local" path
  if (isWhisperAvailable()) return "local";

  // Local not available — try OpenAI as fallback
  if (config.stt.openai.apiKey) {
    console.warn(
      "⚠ faster-whisper not found, falling back to OpenAI Whisper API."
    );
    return "openai";
  }

  throw new Error(
    "No speech-to-text provider available. " +
    "Install faster-whisper (pip install faster-whisper) " +
    "or set STT_PROVIDER=openai and OPENAI_API_KEY in .env"
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

// ---------- Cloud transcriber (OpenAI Whisper API) ----------

async function transcribeOpenAI(
  audioPath: string,
  language: string
): Promise<string> {
  const openai = new OpenAI({ apiKey: config.stt.openai.apiKey });

  const model = config.stt.openai.model;
  const lang = language || config.whisper.language;

  console.log(`  → Sending to OpenAI Whisper API (model: ${model})...`);

  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model,
    language: lang === "auto" ? undefined : lang,
    response_format: "text",
  });

  // The return type is a string when response_format is "text"
  return String(transcription).trim();
}

// ---------- Public API ----------

/**
 * Transcribe an audio file using the configured STT provider.
 *
 * Provider priority:
 * 1. STT_PROVIDER=openai + OPENAI_API_KEY → OpenAI Whisper API (cloud)
 * 2. STT_PROVIDER=local + Python faster-whisper → local (CPU, queued)
 * 3. (Fallback) faster-whisper not found but OPENAI_API_KEY is set → OpenAI
 *
 * @param audioPath - Absolute path to the audio file
 * @param modelSize - Whisper model size (local only: tiny/base/small/medium/large-v3)
 * @param language - Language code (ISO 639-1), defaults to config
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

  if (provider === "openai") {
    return transcribeOpenAI(audioPath, lang);
  }

  return transcribeLocal(audioPath, modelSize, lang, context);
}
