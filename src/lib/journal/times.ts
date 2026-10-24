/** The trade's entry time: enteredAt, or createdAt for entries logged before enteredAt existed. */
export const EFFECTIVE_ENTERED_AT = { $ifNull: ['$enteredAt', '$createdAt'] } as const;

/** A stored entry as the API returns it: enteredAt always set, exitedAt null when unknown. */
export function serializeJournalEntry<T extends { enteredAt?: Date | null; exitedAt?: Date | null; createdAt: Date }>(
  entry: T | { toObject(): T }
): T & { enteredAt: Date; exitedAt: Date | null } {
  const o =
    typeof (entry as { toObject?: () => T }).toObject === 'function'
      ? (entry as { toObject(): T }).toObject()
      : (entry as T);

  return {
    ...o,
    enteredAt: o.enteredAt ?? o.createdAt,
    exitedAt: o.exitedAt ?? null,
  };
}
