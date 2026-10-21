/**
 * Shared formatting helpers for the focus side rail.
 */

export function formatAge(
  timestamp: number | string | Date | null | undefined,
  nowMs: number = Date.now()
): string {
  if (timestamp === null || timestamp === undefined) return 'n/a';
  let targetMs: number;
  if (typeof timestamp === 'string') {
    targetMs = Date.parse(timestamp);
  } else if (timestamp instanceof Date) {
    targetMs = timestamp.getTime();
  } else if (typeof timestamp === 'number') {
    // If timestamp is in seconds (unix timestamp < 1e11), convert to milliseconds.
    targetMs = timestamp < 1e11 ? timestamp * 1000 : timestamp;
  } else {
    return 'n/a';
  }

  if (Number.isNaN(targetMs)) return 'n/a';

  const diffMs = Math.max(0, nowMs - targetMs);
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
