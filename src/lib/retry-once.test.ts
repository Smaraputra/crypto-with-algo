import { describe, expect, it, vi } from 'vitest';
import { retryOnce } from './retry-once';

describe('retryOnce', () => {
  it('returns the first result without retrying', async () => {
    const fn = vi.fn().mockResolvedValue(7);
    await expect(retryOnce(fn, 0)).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries exactly once after a failure', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('first')).mockResolvedValue(8);
    await expect(retryOnce(fn, 0)).resolves.toBe(8);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('propagates the second failure and never tries a third time', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('first')).mockRejectedValueOnce(new Error('second'));
    await expect(retryOnce(fn, 0)).rejects.toThrow('second');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('waits the backoff before the retry', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn().mockRejectedValueOnce(new Error('first')).mockResolvedValue(9);
      const pending = retryOnce(fn, 500);
      await vi.advanceTimersByTimeAsync(499);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe(9);
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
