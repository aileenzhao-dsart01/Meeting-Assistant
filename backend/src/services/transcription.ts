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

// ---------- Audio normalization ----------

const FFMPEG_PATH = "/opt/homebrew/bin/ffmpeg";

interface VolumeInfo {
  meanVolume: number;  // dB
  maxVolume: number;   // dB
}

/**
 * Analyze audio file volume using ffmpeg volumedetect filter.
 * Returns mean and max volume in dB.
 */
function analyzeVolume(audioPath: string): VolumeInfo {
  const result = execSync(
    `${FFMPEG_PATH} -i "${audioPath}" -af volumedetect -vn -sn -f null - 2>&1`,
    { timeout: 30000, encoding: "utf-8" }
  );

  const meanMatch = result.match(/mean_volume:\s+(-?[\d.]+)\s*dB/);
  const maxMatch = result.match(/max_volume:\s+(-?[\d.]+)\s*dB/);

  return {
    meanVolume: meanMatch ? parseFloat(meanMatch[1]) : -99,
    maxVolume: maxMatch ? parseFloat(maxMatch[1]) : -99,
  };
}

/**
 * Check if ffmpeg is available for audio processing.
 */
function isFFmpegAvailable(): boolean {
  try {
    execSync(`${FFMPEG_PATH} -version`, { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Meeting room audio enhancement pipeline.
 *
 * Optimized for:
 * - Distant / far-field microphones (speakers 3-10 ft away)
 * - Multiple speakers at different volumes
 * - Room echo / reverberation
 * - Low-frequency HVAC/ambient rumble
 * - Quiet speakers mixed with loud speakers
 *
 * Pipeline: High-pass filter → Noise reduction → Speech EQ → Compression → Loudness norm
 *
 * @param audioPath - Original audio file path
 * @returns Path to the normalized audio file (caller must clean up)
 */
function normalizeAudio(audioPath: string): string {
  if (!config.audioNormalization.enabled) {
    return audioPath;
  }

  if (!isFFmpegAvailable()) {
    console.warn("  ⚠ ffmpeg not found, skipping audio normalization");
    return audioPath;
  }

  const volume = analyzeVolume(audioPath);
  const target = config.audioNormalization.targetLoudness;
  const gainNeeded = Math.round(target - volume.meanVolume);

  console.log(
    `  → Audio: mean ${volume.meanVolume} dB, max ${volume.maxVolume} dB, ` +
    `target ${target} dB (gain: +${Math.max(0, gainNeeded)} dB)`
  );

  // Only boost if below target (with 1 dB hysteresis to avoid processing close-to-target files)
  if (gainNeeded <= 1 && config.audioNormalization.enableCompression === false) {
    console.log(`  → Volume OK, no normalization needed`);
    return audioPath;
  }

  const ext = path.extname(audioPath) || ".wav";
  let normalizedPath = audioPath.replace(/(\.\w+)$/, "_normalized.wav");
  let counter = 1;
  while (fs.existsSync(normalizedPath)) {
    normalizedPath = audioPath.replace(/(\.\w+)$/, `_normalized_${counter}.wav`);
    counter++;
  }

  // Audio enhancement — simple and reliable
  // Only the most impactful filters: high-pass (rumble removal) + optional compression
  console.log(`  → Applying audio enhancement...`);

  let enhancementFailed = false;

  try {
    // High-pass filter removes room rumble; always beneficial for meeting recordings
    let filterChain = "highpass=f=80";

    // Dynamic range compression evens out quiet vs loud speakers
    if (config.audioNormalization.enableCompression || gainNeeded > 3) {
      filterChain += ",acompressor=threshold=0.2:ratio=4:attack=20:release=250";
    }

    execSync(
      `${FFMPEG_PATH} -i "${audioPath}" -af "${filterChain}" -c:a pcm_s16le -y "${normalizedPath}" 2>&1`,
      { timeout: 600000, encoding: "utf-8" }
    );

    const normSize = fs.statSync(normalizedPath).size;
    if (normSize === 0) throw new Error("Normalized file is empty");
    console.log(`  → Audio enhanced (${(normSize / 1024 / 1024).toFixed(1)} MB)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠ Enhancement failed (${msg.substring(0, 80)}), trying volume gain...`);
    enhancementFailed = true;
  }

  // Fallback: simple volume gain if enhancement failed and gain is needed
  if (enhancementFailed || !fs.existsSync(normalizedPath) || fs.statSync(normalizedPath).size === 0) {
    if (gainNeeded > 1) {
      console.log(`  → Applying volume gain (${gainNeeded} dB)...`);
      try {
        execSync(
          `${FFMPEG_PATH} -i "${audioPath}" -af "volume=${gainNeeded}dB" -c:a pcm_s16le -y "${normalizedPath}" 2>&1`,
          { timeout: 300000, encoding: "utf-8" }
        );
      } catch {
        console.warn(`  ⚠ Volume gain failed, using original audio`);
        return audioPath;
      }
    } else {
      return audioPath;
    }
  }

  const originalSize = fs.statSync(audioPath).size;
  const normalizedSize = fs.statSync(normalizedPath).size;
  console.log(
    `  → Normalized audio: ${(originalSize / 1024 / 1024).toFixed(1)} MB → ` +
    `${(normalizedSize / 1024 / 1024).toFixed(1)} MB`
  );

  return normalizedPath;
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

interface DeepgramUtterance {
  start: number;
  end: number;
  confidence: number;
  channel: number;
  transcript: string;
  words: Array<{
    word: string;
    start: number;
    end: number;
    confidence: number;
    speaker: number;
  }>;
  speaker: number;
  id: string;
}

interface DeepgramAlternative {
  transcript: string;
  confidence: number;
  words: Array<{
    word: string;
    start: number;
    end: number;
    confidence: number;
    speaker?: number;
  }>;
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
  utterances?: DeepgramUtterance[];
}

interface DeepgramMetadata {
  duration: number;
  model_info?: Record<string, { name: string; version: string }>;
}

interface DeepgramResponse {
  results?: DeepgramResult;
  metadata?: DeepgramMetadata;
  error?: string;
}

async function transcribeDeepgram(audioPath: string, language?: string): Promise<string> {
  const apiKey = config.stt.deepgram.apiKey;
  const model = config.stt.deepgram.model;
  const lang = language || config.whisper.language;

  // Step 1: Convert to WAV before sending (most reliable format for STT APIs)
  // Browser-recorded webm (opus in webm container) can cause issues with Deepgram
  let wavPath: string | null = null;
  let audioToSend = audioPath;
  const ext = path.extname(audioPath).toLowerCase();

  try {
    if (ext !== ".wav" && ext !== ".mp3") {
      wavPath = audioPath.replace(/(\.\w+)$/, "_dgtemp.wav");
      let counter = 1;
      while (fs.existsSync(wavPath)) {
        wavPath = audioPath.replace(/(\.\w+)$/, `_dgtemp_${counter}.wav`);
        counter++;
      }

      execSync(
        `${FFMPEG_PATH} -i "${audioPath}" -vn -ar 16000 -ac 1 -sample_fmt s16 -y "${wavPath}" 2>&1`,
        { timeout: 120000, encoding: "utf-8" }
      );

      audioToSend = wavPath;
      const origMB = (fs.statSync(audioPath).size / 1024 / 1024).toFixed(1);
      const wavMB = (fs.statSync(wavPath).size / 1024 / 1024).toFixed(1);
      console.log(`  → Converted ${ext} to WAV for Deepgram (${origMB} MB → ${wavMB} MB)`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠ WAV conversion failed (${msg.substring(0, 100)}), sending original format`);
    if (wavPath && fs.existsSync(wavPath)) {
      try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
    }
    wavPath = null;
    audioToSend = audioPath;
  }

  // Build query params — optimized for meeting transcription
  const params: Record<string, string> = {
    model,
    smart_format: "true",
    punctuate: "true",
    diarize: "true",
    utterances: "true",
    paragraphs: "true",
    numerals: "true",
  };

  if (lang && lang !== "auto") {
    params["language"] = lang === "en" ? "en" : lang;
  } else {
    params["language"] = "en";
  }

  const fileSizeMB = (fs.statSync(audioToSend).size / 1024 / 1024).toFixed(1);
  console.log(`  → Sending to Deepgram API (model: ${model}, language: ${params["language"]}, file: ${fileSizeMB} MB)...`);

  const audioBuffer = fs.readFileSync(audioToSend);

  const response = await fetch(
    `https://api.deepgram.com/v1/listen?${new URLSearchParams(params).toString()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "audio/wav",
      },
      body: audioBuffer,
    }
  );

  // Clean up temp WAV file
  if (wavPath && fs.existsSync(wavPath)) {
    try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
  }

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

  // Log model info if available
  if (data.metadata?.model_info) {
    const info = Object.values(data.metadata.model_info)[0];
    console.log(`  → Deepgram model: ${info?.name} v${info?.version}`);
  }

  // Prefer utterance-level transcript with speaker labels for meetings
  const utterances = data.results?.utterances;
  if (utterances && utterances.length > 0) {
    const speakerLabels = new Map<number, string>();
    let speakerCounter = 0;

    const speakerTranscript = utterances
      .map((utt) => {
        const txt = (utt.transcript || "").trim();
        if (!txt) return null;
        if (!speakerLabels.has(utt.speaker)) {
          speakerLabels.set(utt.speaker, `Speaker ${speakerCounter}`);
          speakerCounter++;
        }
        const label = speakerLabels.get(utt.speaker)!;
        return `${label}: ${txt}`;
      })
      .filter(Boolean)
      .join("\n\n");

    if (speakerTranscript) {
      console.log(`  → Deepgram: ${utterances.length} utterances, ${speakerCounter} speakers detected`);
      return speakerTranscript;
    }
  }

  // Fallback: plain transcript
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();
  if (transcript) {
    return transcript;
  }

  // Last resort: log full response for debugging, then throw
  const responseSummary = JSON.stringify(data).substring(0, 2000);
  console.error(`  ✗ Deepgram empty response. Raw preview: ${responseSummary}`);
  throw new Error(
    "Deepgram returned an empty transcript. This may mean:\n" +
    "1. The audio file contains only silence or background noise\n" +
    "2. The audio format is incompatible (try .wav or .mp3)\n" +
    "3. No speech was detected in the recording"
  );
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

  // Step 1: Normalize audio volume before transcription
  const originalPath = audioPath;
  let normalizedPath: string | null = null;
  try {
    normalizedPath = normalizeAudio(audioPath);
    if (normalizedPath !== audioPath) {
      console.log(`  → Using normalized audio for transcription`);
    }
    audioPath = normalizedPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠ Audio normalization failed (${msg}), using original`);
    audioPath = originalPath;
  }

  try {
    if (provider === "deepgram") {
      const fileSizeMB = fs.statSync(audioPath).size / (1024 * 1024);
      console.log(`  → Audio file: ${fileSizeMB.toFixed(1)} MB`);
      return await transcribeDeepgram(audioPath, lang);
    }

    // Local — queued to avoid OOM
    return await transcribeLocal(audioPath, modelSize, lang, context);
  } finally {
    // Clean up normalized temp file
    if (normalizedPath && normalizedPath !== originalPath && fs.existsSync(normalizedPath)) {
      try {
        fs.unlinkSync(normalizedPath);
        console.log(`  → Cleaned up normalized temp file`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}
