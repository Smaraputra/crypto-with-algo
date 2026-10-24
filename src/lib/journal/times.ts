import type { ScreenshotType } from '@/types/journal';

/** The trade's entry time: enteredAt, or createdAt for entries logged before enteredAt existed. */
export const EFFECTIVE_ENTERED_AT = { $ifNull: ['$enteredAt', '$createdAt'] } as const;

export interface SerializedJournalScreenshot {
  fileId: string;
  contentType: ScreenshotType;
  size: number;
  uploadedAt: Date | string;
}

/** A stored entry as the API returns it: enteredAt always set, exitedAt null when unknown, screenshots formatted. */
export function serializeJournalEntry<
  T extends {
    enteredAt?: Date | null;
    exitedAt?: Date | null;
    createdAt: Date;
    screenshots?: unknown;
  },
>(
  entry: T | { toObject(): T }
): Omit<T, 'screenshots'> & {
  enteredAt: Date;
  exitedAt: Date | null;
  screenshots: SerializedJournalScreenshot[];
} {
  const o =
    typeof (entry as { toObject?: () => T }).toObject === 'function'
      ? (entry as { toObject(): T }).toObject()
      : (entry as T);

  const rawScreenshots = (o as { screenshots?: unknown }).screenshots;
  const screenshots: SerializedJournalScreenshot[] = Array.isArray(rawScreenshots)
    ? rawScreenshots.map((item) => {
        const s =
          typeof (item as { toObject?: () => Record<string, unknown> }).toObject === 'function'
            ? (item as { toObject(): Record<string, unknown> }).toObject()
            : (item as Record<string, unknown>);
        return {
          ...(s as unknown as SerializedJournalScreenshot),
          fileId:
            s.fileId != null
              ? typeof s.fileId === 'string'
                ? s.fileId
                : String(s.fileId)
              : '',
        };
      })
    : [];

  return {
    ...o,
    enteredAt: o.enteredAt ?? o.createdAt,
    exitedAt: o.exitedAt ?? null,
    screenshots,
  };
}
