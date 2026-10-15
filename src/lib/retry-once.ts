/** Default pause before the single retry: long enough to ride out a brief venue hiccup. */
export const RETRY_ONCE_DELAY_MS = 1_000;

/**
 * Runs `fn`, and on a throw waits `delayMs` and runs it exactly once more.
 * The second failure propagates, so a caller never loops on a dead venue.
 */
export async function retryOnce<T>(fn: () => Promise<T>, delayMs: number = RETRY_ONCE_DELAY_MS): Promise<T> {
  try {
    return await fn();
  } catch {
    // The first failure is discarded on purpose: the retry's outcome is the result
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fn();
  }
}
