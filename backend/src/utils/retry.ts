/**
 * Retry helper for transient external failures (network blips, 5xx, 429).
 * Does NOT retry 4xx client errors — those are permanent.
 */

export interface RetryableOptions {
  maxRetries?: number;
  /** Base delay in ms; each retry multiplies by 2 (exponential backoff). */
  baseDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True for statuses that are worth retrying (server/limit errors). */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Run `fn` with exponential backoff on transient failures.
 *
 * `fn` may either return a Response-like object (with `.status`/`.ok`) or throw.
 * A retryable condition is:
 *   - fn throws a network/ECONNRESET/abort-style error, OR
 *   - fn returns a Response-like with a retryable status
 *
 * On a retryable failure it backs off and retries, up to `maxRetries` total
 * attempts. Non-retryable outcomes (4xx, success) are returned immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  isRetryableError?: (err: unknown) => boolean,
  opts: RetryableOptions = {}
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();

      // If the result looks like a Response, check its status.
      if (
        result &&
        typeof result === "object" &&
        "status" in result &&
        typeof (result as { status: unknown }).status === "number"
      ) {
        const status = (result as { status: number }).status;
        if (isRetryableStatus(status) && attempt < maxRetries) {
          const delay = baseDelayMs * 2 ** (attempt - 1);
          console.log(`  → Retryable status ${status}, retrying in ${delay}ms (${attempt}/${maxRetries - 1})...`);
          await sleep(delay);
          continue;
        }
      }
      return result;
    } catch (err) {
      lastErr = err;
      const shouldRetry = isRetryableError ? isRetryableError(err) : true;
      if (shouldRetry && attempt < maxRetries) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        console.log(`  → Transient error (${attempt}/${maxRetries - 1}), retrying in ${delay}ms:`,
          err instanceof Error ? err.message : err);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }

  throw lastErr;
}
