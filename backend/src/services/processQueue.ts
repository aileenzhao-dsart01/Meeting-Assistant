/**
 * Concurrency control for the async processing pipeline.
 *
 * On Render free tier (512MB RAM), running multiple transcription jobs at once
 * stacks ffmpeg + Deepgram uploads + LLM calls and can OOM-kill the process.
 * This module serializes processMeeting so at most `MAX_CONCURRENT` jobs run
 * at a time, queuing the rest.
 */

// On 512MB, one heavy job at a time is the safe default. Deepgram mode is
// mostly I/O, but the local-whisper path and the ffmpeg passes are CPU+RAM
// heavy, and the full transcript JSON is buffered in RAM for a long meeting.
const MAX_CONCURRENT = 1;

let active = 0;
const queue: Array<() => void> = [];

/** Wait for a slot to become available, then run `task`, then release. */
export async function runWithConcurrencyLimit<T>(task: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve) => {
    if (active < MAX_CONCURRENT) {
      active++;
      resolve();
    } else {
      queue.push(() => {
        active++;
        resolve();
      });
    }
  });

  try {
    return await task();
  } finally {
    active--;
    const next = queue.shift();
    if (next) next();
  }
}
