/**
 * Client-safe date and time formatting utilities for the journal.
 * No server imports.
 */

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Format an ISO string or timestamp to "Oct 24, 2026, 14:05" in viewer's local time (en-US, 24-hour, month: 'short').
 * Returns "n/a" for missing or invalid dates.
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'n/a';
  return dateTimeFormatter.format(d);
}

/**
 * Format a Date to YYYY-MM-DDTHH:mm in local time for <input type="datetime-local">.
 */
export function toLocalInputValue(date: Date): string {
  if (isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/**
 * Parse a datetime-local input string (YYYY-MM-DDTHH:mm) to an ISO string in UTC,
 * or null for empty or invalid values.
 */
export function fromLocalInputValue(value: string): string | null {
  if (!value || !value.trim()) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Format hold duration between enteredAt and exitedAt.
 * Returns null when either is missing, invalid, or exited is before entered.
 * Formats: "under 1m", "45m", "5h 20m" or "3d 4h" (drops a zero second unit, e.g. "2h" and "1d").
 */
export function formatHold(
  enteredAt: string | null | undefined,
  exitedAt: string | null | undefined
): string | null {
  if (!enteredAt || !exitedAt) return null;
  const start = new Date(enteredAt).getTime();
  const end = new Date(exitedAt).getTime();
  if (isNaN(start) || isNaN(end) || end < start) return null;

  const diffMs = end - start;
  const totalMinutes = Math.floor(diffMs / 60000);

  if (totalMinutes < 1) {
    return 'under 1m';
  }

  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  if (totalMinutes < 1440) {
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (minutes === 0) {
      return `${hours}h`;
    }
    return `${hours}h ${minutes}m`;
  }

  const days = Math.floor(totalMinutes / 1440);
  const remainingMinutes = totalMinutes % 1440;
  const hours = Math.floor(remainingMinutes / 60);
  if (hours === 0) {
    return `${days}d`;
  }
  return `${days}d ${hours}h`;
}
