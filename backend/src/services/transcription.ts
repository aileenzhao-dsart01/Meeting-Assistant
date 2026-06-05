import { execSync, exec } from "child_process";
import fs from "fs";
import path from "path";
import { config } from "../config";

/**
 * Check if faster-whisper is available in the system Python environment.
 */
export function isWhisperAvailable(): boolean {
  try {
    execSync("python3 -c \"import faster_whisper; print(faster_whisper.__version__)\"", {
      stdio: "pipe",
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Transcribe an audio file using faster-whisper with VAD filtering.
 *
 * VAD (Voice Activity Detection) is enabled by default, which:
 * - Filters out silence/noise from distant microphones
 * - Speeds up processing of long meetings
 * - Improves accuracy for multi-talker scenarios
 *
 * @param audioPath - Absolute path to the audio file
 * @param modelSize - Whisper model size (tiny, base, small, medium, large-v3)
 * @param language - Language code (ISO 639-1), defaults to config or "en"
 * @returns The transcribed text
 */
export async function transcribeAudio(
  audioPath: string,
  modelSize: string = config.whisper.modelSize,
  language?: string
): Promise<string> {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  if (!isWhisperAvailable()) {
    throw new Error(
      "faster-whisper is not installed. Run: pip install faster-whisper"
    );
  }

  const scriptPath = path.resolve(__dirname, "..", "..", "scripts", "transcribe.py");
  const langArg = language || config.whisper.language;

  return new Promise((resolve, reject) => {
    const child = exec(
      `python3 "${scriptPath}" "${audioPath}" "${modelSize}" "${langArg}"`,
      {
        timeout: 120 * 60 * 1000, // 2 hour timeout for long meetings + VAD processing
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large transcripts
      },
      (error, stdout, stderr) => {
        if (error) {
          // VAD logs progress info to stderr — only treat as error if stdout is empty
          if (!stdout?.trim()) {
            reject(new Error(`Transcription failed: ${stderr || error.message}`));
            return;
          }
        }
        resolve(stdout.trim());
      }
    );
  });
}
