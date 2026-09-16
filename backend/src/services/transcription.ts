import { execSync, exec, execFile, execFileSync } from "child_process";
import fs from "fs";
import http from "http";
import https from "https";
import path from "path";
import { config } from "../config";
import { withRetry } from "../utils/retry";

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

/** EBML magic — starts every Matroska/WebM document. */
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

/**
 * Detect a WebM/Matroska file that is actually two recordings spliced together.
 *
 * When the browser's MediaRecorder is stopped and restarted mid-meeting (pause,
 * tab sleep, reconnect) the frontend can concatenate the resulting blobs into a
 * single file. Each recording carries its own EBML header + Segment, so the
 * second header resets the cluster timeline to zero partway through.
 *
 * Deepgram's demuxer rejects that outright:
 *   "failed to process audio: corrupt or unsupported data"
 * while ffmpeg tolerates it and re-times the stream — hence the transcode
 * fallback in transcribeDeepgram().
 *
 * A well-formed file has exactly one EBML header at offset 0.
 */
function isConcatenatedWebm(filePath: string): { concatenated: boolean; at: number } {
  // Sniff the magic bytes rather than trusting the extension: uploads are named
  // from the client-supplied originalname, and we already have a file in storage
  // named ".wav" whose contents are actually WebM.
  if (!startsWithEbmlMagic(filePath)) {
    return { concatenated: false, at: -1 };
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const CHUNK = 1024 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK);
    // Carry the last 3 bytes across chunk boundaries so a header straddling a
    // boundary is still found.
    let carry = Buffer.alloc(0);
    let base = 0; // absolute file offset of window[0]

    for (;;) {
      const read = fs.readSync(fd, buf, 0, CHUNK, null);
      if (read <= 0) break;

      const window = Buffer.concat([carry, buf.subarray(0, read)]);
      // Skip index 0: a single well-formed file's only header lives there.
      const at = window.indexOf(EBML_MAGIC, 1);
      if (at !== -1) {
        return { concatenated: true, at: base + at };
      }

      const carryLen = EBML_MAGIC.length - 1;
      carry = window.subarray(window.length - carryLen);
      base += window.length - carryLen;
    }
  } catch (err) {
    // Unreadable file — let the normal upload path surface the real error.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠ Could not scan ${path.basename(filePath)} for concatenation: ${msg}`);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  return { concatenated: false, at: -1 };
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

/**
 * Resolve the ffmpeg binary.
 *
 * Order:
 *   1. FFMPEG_PATH env var — explicit override
 *   2. @ffmpeg-installer/ffmpeg — ships a platform-specific static binary
 *      (bundled with the npm install, so it exists on Render without apt-get)
 *   3. "ffmpeg" on PATH — whatever the host provides
 *
 * This deliberately has no hardcoded macOS path: the previous
 * "/opt/homebrew/bin/ffmpeg" never existed on Render, so every ffmpeg call
 * silently fell back to the original audio and the cloud pipeline ran with
 * no transcoding at all.
 */
function resolveFfmpegPath(): string {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;

  try {
    const installer = require("@ffmpeg-installer/ffmpeg") as { path?: string };
    if (installer?.path) return installer.path;
  } catch {
    // Package not installed (e.g. local dev with ffmpeg on PATH) — fall through
  }

  return "ffmpeg";
}

const FFMPEG_PATH = resolveFfmpegPath();

interface VolumeInfo {
  meanVolume: number;  // dB
  maxVolume: number;   // dB
}

/**
 * Run an async ffmpeg command without blocking the event loop.
 * Returns stdout (with stderr merged, since ffmpeg logs to stderr).
 */
async function runFfmpeg(args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(FFMPEG_PATH, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      const merged = (stdout || "") + (stderr || "");
      if (error) {
        const err = new Error(merged.trim() || error.message);
        (err as Error & { code?: unknown }).code = (error as any).code;
        reject(err);
      } else {
        resolve(merged);
      }
    });
    child.stderr?.on("data", () => { /* collected via callback */ });
  });
}

/**
 * Analyze audio file volume using ffmpeg volumedetect filter.
 * Returns mean and max volume in dB.
 */
async function analyzeVolume(audioPath: string): Promise<VolumeInfo> {
  const result = await runFfmpeg(
    ["-i", audioPath, "-af", "volumedetect", "-vn", "-sn", "-f", "null", "-"],
    30000
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
    // execFile (not exec): FFMPEG_PATH is now an absolute path from the
    // @ffmpeg-installer package and can contain spaces, which an interpolated
    // shell string would split into separate arguments.
    execFileSync(FFMPEG_PATH, ["-version"], { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Final stage of every enhancement chain.
 *
 * The chain stacks up to +16 dB of EQ boost on top of up to +30 dB of gain with
 * nothing to catch it, and meeting-room recordings routinely arrive already
 * peaking at 0 dBFS. Measured on a real 48-min upload, that clipped hard
 * (astats flat factor 9.3 — i.e. thousands of flat-topped samples).
 *
 * limit=0.95 (-0.45 dBFS) leaves headroom for the 16 kHz resample that follows,
 * which can overshoot slightly on its own.
 *
 * MUST stay last in the chain. Resampling before the limiter re-introduces
 * overshoot — measured flat factor 0.17 with the resample first, vs 0.00 here.
 */
const LIMITER = "alimiter=limit=0.95";

/**
 * Output options for every normalized WAV.
 *
 * 16 kHz mono is what both Deepgram and Whisper resample to internally anyway
 * (Whisper's feature extractor is 16 kHz log-mel), and every chain branch has
 * `lowpass=f=8000` — i.e. at 16 kHz sampling nothing the chain lets through
 * falls above Nyquist. So this is lossless here, but ~6x smaller to upload
 * (a 48-min meeting went from 527 MB to ~88 MB).
 *
 * These are output options, not chain entries: putting the resample inside
 * `-af` changes what the EQ and limiter operate on and shifts the result.
 */
const STT_OUTPUT_ARGS = ["-ar", "16000", "-ac", "1"];

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
 * Pipeline: High-pass → Speech EQ → Compression → Limiter → 16kHz mono downmix
 *
 * @param audioPath - Original audio file path
 * @returns Path to the normalized audio file (caller must clean up)
 */
export async function normalizeAudio(audioPath: string): Promise<string> {
  if (!config.audioNormalization.enabled) {
    return audioPath;
  }

  if (!isFFmpegAvailable()) {
    console.warn("  ⚠ ffmpeg not found, skipping audio normalization");
    return audioPath;
  }

  const volume = await analyzeVolume(audioPath);
  const target = config.audioNormalization.targetLoudness;
  const gainNeeded = Math.round(target - volume.meanVolume);

  // For very quiet recordings (< -25 dB): over-boost to compensate for
  // energy loss from the band-pass filter. Otherwise use standard gain.
  const effectiveGain = volume.meanVolume < -25
    ? Math.min(Math.max(Math.round(gainNeeded * 1.3), 20), 30)
    : Math.min(Math.max(gainNeeded, 2), 30);

  console.log(
    `  → Audio: mean ${volume.meanVolume} dB, max ${volume.maxVolume} dB, ` +
    `target ${target} dB (gain: +${effectiveGain} dB, raw: +${Math.max(0, gainNeeded)} dB)`
  );

  // Only skip if level is adequate AND clarity mode is at minimum
  if (effectiveGain <= 1 && config.audioNormalization.clarityMode === "basic") {
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

  // Audio enhancement — pronunciation clarity pipeline
  // Wider band-pass (150-8000Hz) preserves consonant detail.
  // 3-layer EQ: cut boxy 200Hz, boost consonant clarity at 3kHz,
  // add presence at 6.5kHz for sibilants (s, sh, f, th).
  // No noise reduction, no dynaudnorm, no gate — pure EQ + max gain.
  console.log(`  → Applying audio enhancement (mode: ${config.audioNormalization.clarityMode})...`);

  const mode = config.audioNormalization.clarityMode;
  let filterChain = "";
  let enhancementFailed = false;

  try {
    switch (mode) {
      case "basic":
        // Light bump: remove subsonic rumble + gentle volume
        filterChain = [
          "highpass=f=100",
          "lowpass=f=8000",
        ].join(",");
        if (effectiveGain > 1) filterChain += `,volume=${effectiveGain}dB`;
        break;

      case "speech":
      default:
        // Pronunciation clarity: wider band to preserve consonants + layered EQ
        // Key frequencies. Consonant clarity lives in 2-4kHz (s, t, k) and
        // 5-8kHz (sibilants, f, th). Keep lowpass at 8kHz for this.
        filterChain = [
          "highpass=f=150",               // remove sub rumble only
          "lowpass=f=8000",               // keep consonants (was 3600Hz)
          "equalizer=f=200:t=h:w=150:g=-5", // cut boxy/muddy resonance
          "equalizer=f=3000:t=h:w=1500:g=12", // strong consonant clarity boost
          "equalizer=f=6500:t=h:w=2000:g=4",  // presence/air for sibilants
        ].join(",");
        if (effectiveGain > 1) filterChain += `,volume=${effectiveGain}dB`;
        break;

      case "max":
        // Pronunciation clarity + compression for very uneven levels
        filterChain = [
          "highpass=f=150",
          "lowpass=f=8000",
          "equalizer=f=200:t=h:w=150:g=-5",
          "equalizer=f=3000:t=h:w=1500:g=12",
          "equalizer=f=6500:t=h:w=2000:g=4",
          "acompressor=threshold=0.15:ratio=4:attack=5:release=150",
        ].join(",");
        if (effectiveGain > 1) filterChain += `,volume=${effectiveGain}dB`;
        break;
    }

    // Cap the peak, always last — the EQ boosts and gain above can overshoot 0 dBFS.
    filterChain += `,${LIMITER}`;

    await runFfmpeg(
      ["-i", audioPath, "-af", filterChain, ...STT_OUTPUT_ARGS, "-c:a", "pcm_s16le", "-y", normalizedPath],
      600000
    );

    const normSize = fs.statSync(normalizedPath).size;
    if (normSize === 0) throw new Error("Normalized file is empty");
    console.log(`  → Audio enhanced (${(normSize / 1024 / 1024).toFixed(1)} MB)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠ ${mode} enhancement failed (${msg.substring(0, 80)}), trying basic...`);
    enhancementFailed = true;
  }

  // Fallback: simpler modes
  if (enhancementFailed || !fs.existsSync(normalizedPath) || fs.statSync(normalizedPath).size === 0) {
    let fallbackOk = false;

    // Try basic mode
    if (mode !== "basic" && !fallbackOk) {
      try {
        const fbChain = "highpass=f=100,lowpass=f=8000" +
          (effectiveGain > 1 ? `,volume=${effectiveGain}dB` : "") +
          `,${LIMITER}`;
        await runFfmpeg(
          ["-i", audioPath, "-af", fbChain, ...STT_OUTPUT_ARGS, "-c:a", "pcm_s16le", "-y", normalizedPath],
          300000
        );
        if (fs.statSync(normalizedPath).size > 0) {
          console.log(`  → Fallback to basic mode OK`);
          fallbackOk = true;
        }
      } catch { /* next fallback */ }
    }

    // Volume gain only
    if (!fallbackOk && effectiveGain > 1) {
      console.log(`  → Fallback: volume gain (${effectiveGain} dB)...`);
      try {
        await runFfmpeg(
          ["-i", audioPath, "-af", `volume=${effectiveGain}dB,${LIMITER}`, ...STT_OUTPUT_ARGS, "-c:a", "pcm_s16le", "-y", normalizedPath],
          300000
        );
        if (fs.statSync(normalizedPath).size > 0) fallbackOk = true;
      } catch { /* skip */ }
    }

    if (!fallbackOk) {
      console.warn(`  ⚠ All enhancement failed, using original audio`);
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
 * Report which ffmpeg binary resolved, and whether it actually runs.
 *
 * Called at startup. ffmpeg being absent used to be entirely invisible: every
 * audio step silently fell back to the original file, so a missing binary only
 * ever surfaced as an opaque Deepgram 400 on a long meeting. The
 * @ffmpeg-installer binaries are optionalDependencies, so a failed platform
 * install is NOT a build error — without this line nothing would report it.
 */
export function logFfmpegStatus(): void {
  if (!config.audioNormalization.enabled) {
    console.log(`  ffmpeg: skipped (AUDIO_NORMALIZE=false)`);
    return;
  }

  if (isFFmpegAvailable()) {
    console.log(`  ffmpeg: ✓ available (${FFMPEG_PATH})`);
    return;
  }

  console.warn(
    `  ffmpeg: ✗ NOT AVAILABLE (tried: ${FFMPEG_PATH}) — audio normalization and ` +
    `container repair are DISABLED. Check that @ffmpeg-installer/ffmpeg installed ` +
    `for this platform, or set FFMPEG_PATH.`
  );
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
          maxBuffer: 200 * 1024 * 1024, // 200MB
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

// ---------- Long-timeout request helper ----------

/**
 * Perform a request with a long idle timeout, suitable for transcription
 * APIs that queue long files and take several minutes to respond.
 *
 * Node's global fetch() (undici) aborts after 5 minutes with no response
 * headers, which breaks transcription of meetings > ~30 min. This uses the
 * built-in http/https modules instead, with a generous idle timeout.
 */
function requestLongTimeout(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: Buffer | NodeJS.ReadableStream }
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === "https:" ? https : http;

    const req = mod.request(
      parsed,
      {
        method: init.method || "GET",
        headers: init.headers,
        timeout: 2 * 60 * 60 * 1000, // 2 hour idle timeout
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve(
            new Response(body, {
              status: res.statusCode || 500,
              headers: res.headers as Record<string, string>,
            })
          );
        });
        res.on("error", reject);
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Request timed out after 2 hours"));
    });
    req.on("error", reject);

    if (Buffer.isBuffer(init.body)) {
      req.write(init.body);
      req.end();
    } else if (init.body) {
      // Stream the body — backpressure is handled by pipe
      init.body.pipe(req);
      init.body.on("error", (err) => req.destroy(err));
    } else {
      req.end();
    }
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

/**
 * Transcode any container to a 16kHz mono PCM WAV.
 *
 * Two independent jobs, which is why it is not just "normalization":
 *   1. Deepgram is most reliable with plain WAV — it avoids container-level
 *      demuxing entirely (which is what rejects concatenated WebM).
 *   2. Re-encoding re-times the stream, repairing the duplicated headers and
 *      the cluster-timeline reset a concatenated recording carries.
 *
 * ffmpeg reports the duplicated header as "File ended prematurely" but still
 * decodes every frame, so a non-zero exit alone is not fatal — we validate the
 * output instead.
 */
async function transcodeToWav(inputPath: string): Promise<string> {
  let outPath = inputPath.replace(/(\.\w+)$/, "_dgtemp.wav");
  let counter = 1;
  while (fs.existsSync(outPath)) {
    outPath = inputPath.replace(/(\.\w+)$/, `_dgtemp_${counter}.wav`);
    counter++;
  }

  try {
    await runFfmpeg(
      ["-i", inputPath, "-vn", "-ar", "16000", "-ac", "1", "-sample_fmt", "s16", "-y", outPath],
      600000
    );
  } catch (err) {
    // Salvage a partial transcode: a concatenated file makes ffmpeg exit
    // non-zero ("File ended prematurely") even though the output is complete.
    const usable =
      fs.existsSync(outPath) &&
      fs.statSync(outPath).size > 44 && // more than a bare WAV header
      isWavFile(outPath);

    if (!usable) throw err;

    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  ⚠ ffmpeg exited non-zero but produced valid WAV (${msg.slice(0, 80)})`);
  }

  if (!fs.existsSync(outPath) || fs.statSync(outPath).size <= 44) {
    throw new Error("Transcode produced an empty WAV");
  }

  return outPath;
}

/** True if the file begins with the EBML magic (a Matroska/WebM document). */
function startsWithEbmlMagic(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(4);
    if (fs.readSync(fd, head, 0, 4, 0) < 4) return false;
    return head.equals(EBML_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** Check a RIFF/WAVE header rather than trusting the file extension. */
function isWavFile(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) < 12) return false;
    return (
      head.toString("ascii", 0, 4) === "RIFF" &&
      head.toString("ascii", 8, 12) === "WAVE"
    );
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

async function transcribeDeepgram(audioPath: string, language?: string): Promise<string> {
  const apiKey = config.stt.deepgram.apiKey;
  const model = config.stt.deepgram.model;
  const lang = language || config.whisper.language;

  // Step 1: Decide the wire format.
  // - Healthy compressed uploads stream as-is: smaller, no CPU cost.
  // - A concatenated recording is transcoded up front, because we know
  //   Deepgram will reject it.
  let wavPath: string | null = null;
  let audioToSend = audioPath;
  const ext = path.extname(audioPath).toLowerCase();

  const concat = isConcatenatedWebm(audioPath);
  if (concat.concatenated) {
    console.warn(
      `  ⚠ Audio looks like two spliced recordings (2nd header @ byte ${concat.at}) — ` +
      `transcoding before upload`
    );
  }

  // A file claiming .wav/.mp3 can be lying — we hold one named ".wav" that is
  // actually WebM. Send raw only when the bytes really are a plain WAV, since
  // that is the one container guaranteed to need no demuxing.
  const rawSendSafe = isWavFile(audioPath);

  if (concat.concatenated || !rawSendSafe) {
    try {
      wavPath = await transcodeToWav(audioPath);
      audioToSend = wavPath;

      const origMB = (fs.statSync(audioPath).size / 1024 / 1024).toFixed(1);
      const wavMB = (fs.statSync(wavPath).size / 1024 / 1024).toFixed(1);
      console.log(`  → Converted ${ext} to WAV for Deepgram (${origMB} MB → ${wavMB} MB)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠ WAV conversion failed (${msg.substring(0, 100)}), sending original format`);
      if (wavPath && fs.existsSync(wavPath)) {
        try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
      }
      wavPath = null;
      audioToSend = audioPath;
    }
  }

  // Build query params — optimized for meeting transcription
  // Use URLSearchParams directly for proper multi-value support (keywords)
  const searchParams = new URLSearchParams();
  searchParams.set("model", model);
  searchParams.set("smart_format", "true");
  searchParams.set("punctuate", "true");
  searchParams.set("diarize", "true");
  searchParams.set("utterances", "true");
  searchParams.set("paragraphs", "true");
  searchParams.set("numerals", "true");
  searchParams.set("filler_words", config.stt.deepgram.filterFiller ? "false" : "true");

  // Add keyterm boosting for speaker names and domain jargon
  // Deepgram accepts multiple keywords params: ?keywords=term1&keywords=term2
  if (config.stt.deepgram.keywords) {
    for (const term of config.stt.deepgram.keywords.split(",").map(t => t.trim()).filter(Boolean)) {
      searchParams.append("keywords", term);
    }
  }

  if (lang && lang !== "auto") {
    searchParams.set("language", lang === "en" ? "en" : lang);
  } else {
    searchParams.set("language", "en");
  }

  const url = `https://api.deepgram.com/v1/listen?${searchParams.toString()}`;

  // Stream the file body — avoids loading a multi-hundred-MB buffer into RAM
  // (a 2h meeting would OOM on Render's 512MB instance).
  // Content-Type must match the actual container (webm/opus, mp3), not "audio/wav".
  // Retry transient 5xx/429 responses (the WAV file must survive between
  // attempts, so cleanup happens in the finally below, not between attempts).
  const send = (bodyPath: string): Promise<Response> =>
    withRetry(
      () => requestLongTimeout(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": getMimeType(bodyPath),
          "Content-Length": String(fs.statSync(bodyPath).size),
        },
        body: fs.createReadStream(bodyPath),
      }),
      (err) => {
        // Retry on network-level errors (ECONNRESET, socket hang up, etc.)
        const msg = err instanceof Error ? err.message : String(err);
        return !/^(4\d\d|401|403)/.test(msg);
      },
      { maxRetries: 3, baseDelayMs: 1500 }
    );

  let response: Response;
  try {
    const fileSizeMB = (fs.statSync(audioToSend).size / 1024 / 1024).toFixed(1);
    console.log(`  → Sending to Deepgram API (model: ${model}, language: ${searchParams.get("language")}, file: ${fileSizeMB} MB)...`);

    response = await send(audioToSend);

    // Deepgram rejects a malformed container outright rather than degrading,
    // which is what a concatenated WebM hits. If we streamed the original and
    // got that 400, transcode once and retry — the transcode re-times the
    // stream and normalizes it to WAV, which always parses.
    if (!response.ok && response.status === 400 && audioToSend !== audioPath) {
      const preview = (await response.text()).substring(0, 300);
      if (/corrupt or unsupported data/i.test(preview)) {
        console.warn(`  ⚠ Deepgram rejected the container — retrying from a transcoded WAV`);
        try {
          const retryWav = await transcodeToWav(audioPath);
          if (wavPath && fs.existsSync(wavPath)) {
            try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
          }
          wavPath = retryWav;
          audioToSend = retryWav;
          response = await send(audioToSend);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  ✗ Transcode fallback failed: ${msg.slice(0, 200)}`);
          response = new Response(preview, { status: 400 });
        }
      } else {
        response = new Response(preview, { status: 400 });
      }
    }
  } finally {
    // Clean up temp WAV file (after retries complete, success or failure)
    if (wavPath && fs.existsSync(wavPath)) {
      try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
    }
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

    // Group consecutive utterances by speaker to avoid choppy output
    // (Deepgram splits on pauses, so one thought can be many utterances)
    const grouped: { label: string; texts: string[] }[] = [];

    for (const utt of utterances) {
      const txt = (utt.transcript || "").trim();
      if (!txt) continue;

      if (!speakerLabels.has(utt.speaker)) {
        speakerLabels.set(utt.speaker, `Speaker ${speakerCounter}`);
        speakerCounter++;
      }
      const label = speakerLabels.get(utt.speaker)!;

      const last = grouped[grouped.length - 1];
      if (last && last.label === label) {
        // Same speaker — append to existing block
        last.texts.push(txt);
      } else {
        // New speaker — start a new block
        grouped.push({ label, texts: [txt] });
      }
    }

    const speakerTranscript = grouped
      .map((g) => `${g.label}: ${g.texts.join(" ")}`)
      .join("\n\n");

    if (speakerTranscript) {
      console.log(`  → Deepgram: ${utterances.length} utterances → ${grouped.length} speaker blocks, ${speakerCounter} speakers detected`);
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
    normalizedPath = await normalizeAudio(audioPath);
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
