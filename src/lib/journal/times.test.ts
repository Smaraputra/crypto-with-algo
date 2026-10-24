import { describe, expect, it } from 'vitest';
import { EFFECTIVE_ENTERED_AT, serializeJournalEntry } from './times';

describe('EFFECTIVE_ENTERED_AT', () => {
  it('defines the Mongo aggregation fallback expression', () => {
    expect(EFFECTIVE_ENTERED_AT).toEqual({ $ifNull: ['$enteredAt', '$createdAt'] });
  });
});

describe('serializeJournalEntry', () => {
  const createdAt = new Date('2026-01-10T10:00:00.000Z');
  const enteredAt = new Date('2026-01-05T09:30:00.000Z');
  const exitedAt = new Date('2026-01-05T15:45:00.000Z');

  it('a plain object without enteredAt gets createdAt', () => {
    const entry = {
      id: 'entry-1',
      createdAt,
    };
    const result = serializeJournalEntry(entry);
    expect(result.enteredAt).toEqual(createdAt);
    expect(result.id).toBe('entry-1');
  });

  it('one with enteredAt keeps it', () => {
    const entry = {
      id: 'entry-2',
      enteredAt,
      createdAt,
    };
    const result = serializeJournalEntry(entry);
    expect(result.enteredAt).toEqual(enteredAt);
  });

  it('a { toObject } wrapper is unwrapped', () => {
    const innerDoc = {
      id: 'entry-3',
      createdAt,
      enteredAt,
      exitedAt,
    };
    const wrapper = {
      toObject: () => innerDoc,
    };
    const result = serializeJournalEntry(wrapper);
    expect(result.id).toBe('entry-3');
    expect(result.enteredAt).toEqual(enteredAt);
    expect(result.exitedAt).toEqual(exitedAt);
  });

  it('exitedAt undefined becomes null', () => {
    const entry = {
      id: 'entry-4',
      createdAt,
    };
    const result = serializeJournalEntry(entry);
    expect(result.exitedAt).toBeNull();
  });

  it('exitedAt set to a date remains the date', () => {
    const entry = {
      id: 'entry-5',
      createdAt,
      exitedAt,
    };
    const result = serializeJournalEntry(entry);
    expect(result.exitedAt).toEqual(exitedAt);
  });

  it('exitedAt null remains null', () => {
    const entry = {
      id: 'entry-6',
      createdAt,
      exitedAt: null,
    };
    const result = serializeJournalEntry(entry);
    expect(result.exitedAt).toBeNull();
  });
});
