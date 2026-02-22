/**
 * Retry with exponential backoff + Telegram FloodWait awareness.
 */

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isFloodWaitError(err: unknown): err is { errorMessage: string; seconds: number } {
  return (
    typeof err === "object" &&
    err !== null &&
    "errorMessage" in err &&
    (err as Record<string, unknown>).errorMessage === "FLOOD_WAIT" &&
    "seconds" in err
  );
}

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return /TIMEOUT|ECONNRESET|ETIMEDOUT|NETWORK/i.test(msg);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { maxRetries, baseDelayMs = 1000, maxDelayMs = 30000, onRetry } = options;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries) throw err;

      let delayMs: number;

      if (isFloodWaitError(err)) {
        delayMs = err.seconds * 1000;
      } else if (isTransientError(err)) {
        // Exponential backoff with jitter
        delayMs = Math.min(baseDelayMs * 2 ** attempt + Math.random() * 500, maxDelayMs);
      } else {
        // Non-retryable error — propagate immediately
        throw err;
      }

      onRetry?.(err, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }
}
