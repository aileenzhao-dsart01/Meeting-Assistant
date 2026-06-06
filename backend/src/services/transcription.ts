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
  let normalizedPath = audioPath.replace(/(\.\w+)$/, "_normalized$1");
  let counter = 1;
  while (fs.existsSync(normalizedPath)) {
    normalizedPath = audioPath.replace(/(\.\w+)$/, `_normalized_${counter}$1`);
    counter++;
  }

  // Build the filter chain for meeting room audio
  // Each filter addresses a specific room recording issue
  const filters: string[] = [];

  // 1. High-pass filter — removes low-frequency room rumble (HVAC, traffic, hum)
  //    80 Hz cuts room rumble without losing male speech (lowest male fundamental ~85 Hz)
  filters.push("highpass=f=80");

  // 2. Low-pass filter — removes high-frequency noise above speech range
  filters.push("lowpass=f=7500");

  // 3. Noise reduction — ffmpeg's afftdn filter adaptively reduces background noise
  //    Works well for consistent room noise (fans, projectors, AC hum)
  filters.push("afftdn=nf=-25");

  // 4. Speech-focused equalization — boost clarity frequencies, reduce muddy ones
  //    - Slight cut at 200-300 Hz (reduces "boxy" room sound)
  //    - Boost at 2-4 kHz (speech intelligibility / consonant clarity)
  //    - Gentle high shelf at 6 kHz (adds air/sparkle for distant mics)
  filters.push("equalizer=f=240:t=h:w=200:g=-2,equalizer=f=2500:t=h:w=800:g=4,equalizer=f=6000:t=h:w=2000:g=2");

  // 5. Dynamic range compression — evens out quiet vs loud speakers
  //    - Low threshold catches distant/quiet speakers
  //    - 4:1 ratio prevents loud speakers from clipping
  //    - Fast attack catches sudden loud noises, slow release sounds natural
  //    - Only applied if compression is enabled
  if (config.audioNormalization.enableCompression || gainNeeded > 3) {
    filters.push("acompressor=threshold=0.15:ratio=4:attack=20:release=250:makeup=true");
  }

  // 6. Loudness normalization — bring overall level to broadcast standard
  //    Uses EBU R128 loudnorm for consistent perceived loudness
  filters.push(`loudnorm=I=${target}:LRA=7:TP=-1.5`);

  const filterChain = filters.join(",");

  const cmd =
    `${FFMPEG_PATH} -i "${audioPath}" -af "${filterChain}" ` +
    `-c:a pcm_s16le -y "${normalizedPath}" 2>&1`;

  console.log(`  → Applying meeting room audio enhancement...`);

  try {
    execSync(cmd, { timeout: 600000, encoding: "utf-8" }); // 10 min for long files
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠ Meeting room enhancement failed (${msg.substring(0, 100)}), trying simple gain...`);

    // Fallback: simple volume boost
    const fallbackCmd =
      `${FFMPEG_PATH} -i "${audioPath}" -af "volume=${Math.max(2, gainNeeded)}dB" ` +
      `-y "${normalizedPath}" 2>&1`;
    try {
      execSync(fallbackCmd, { timeout: 300000, encoding: "utf-8" });
    } catch {
      console.warn(`  ⚠ Simple gain also failed, using original audio`);
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

  // Build query params — optimized for meeting transcription with accented speakers
  const params: Record<string, string> = {
    model,
    smart_format: "true",
    punctuate: "true",
    diarize: "true",
    utterances: "true",
    paragraphs: "true",
    // Improve number/date formatting for marketing metrics
    numerals: "true",
    // Reduce filler words in the transcript
    filler_words: "false",
  };

  // Set language — for accented English, "en" (general) often outperforms "en-US"
  if (lang && lang !== "auto") {
    // Map to Deepgram-compatible language codes
    const dgLang = lang === "en" ? "en" : lang;
    params["language"] = dgLang;
    // Add language fallback for code-switching
    if (dgLang !== "en") {
      params["model"] = "nova-3";
    }
  } else if (!lang || lang === "auto") {
    // Enable language detection for mixed-language meetings
    params["model"] = "nova-3";
    params["language"] = "en"; // fallback default
  }

  console.log(`  → Sending to Deepgram API (model: ${params["model"]}, language: ${params["language"] || "auto"})...`);

  const audioBuffer = fs.readFileSync(audioPath);
  const mimeType = getMimeType(audioPath);

  const response = await fetch(
    `https://api.deepgram.com/v1/listen?${new URLSearchParams(params).toString()}`,
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

  // Prefer utterance-level transcript with speaker labels for meetings
  const utterances = data.results?.utterances;
  if (utterances && utterances.length > 0) {
    const speakerLabels = new Map<number, string>();
    let speakerCounter = 0;

    const speakerTranscript = utterances
      .map((utt) => {
        // Assign consistent speaker labels
        if (!speakerLabels.has(utt.speaker)) {
          speakerLabels.set(utt.speaker, `Speaker ${speakerCounter}`);
          speakerCounter++;
        }
        const label = speakerLabels.get(utt.speaker)!;
        return `${label}: ${utt.transcript.trim()}`;
      })
      .join("\n\n");

    // Also return the full plain transcript (no labels) for summarization
    const fullTranscript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();

    // Return speaker-labeled version; the raw full transcript is accessible if needed
    console.log(`  → Deepgram: ${utterances.length} utterances, ${speakerCounter} speakers detected`);
    return speakerTranscript;
  }

  // Fallback: plain transcript (no utterances/diarization in response)
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim();

  if (!transcript) {
    throw new Error("Deepgram returned empty transcript");
  }

  // Log model info if available
  if (data.metadata?.model_info) {
    const info = Object.values(data.metadata.model_info)[0];
    console.log(`  → Deepgram model: ${info?.name} v${info?.version}`);
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
