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

  it('defaults screenshots to an empty array when undefined or null', () => {
    const entryWithoutScreenshots = {
      id: 'entry-7',
      createdAt,
    };
    const result1 = serializeJournalEntry(entryWithoutScreenshots);
    expect(result1.screenshots).toEqual([]);

    const entryWithNullScreenshots = {
      id: 'entry-8',
      createdAt,
      screenshots: null,
    };
    const result2 = serializeJournalEntry(entryWithNullScreenshots);
    expect(result2.screenshots).toEqual([]);
  });

  it('maps each fileId to its string form', () => {
    const uploadedAt = new Date('2026-01-05T10:00:00.000Z');
    const mockObjectId = {
      toString: () => '60d5ec49f1b2c8b1f8c1b2c8',
    };
    const entry = {
      id: 'entry-9',
      createdAt,
      screenshots: [
        {
          fileId: mockObjectId,
          contentType: 'image/png' as const,
          size: 1024,
          uploadedAt,
        },
        {
          fileId: '60d5ec49f1b2c8b1f8c1b2c9',
          contentType: 'image/jpeg' as const,
          size: 2048,
          uploadedAt,
        },
      ],
    };
    const result = serializeJournalEntry(entry);
    expect(result.screenshots).toHaveLength(2);
    expect(result.screenshots[0]).toEqual({
      fileId: '60d5ec49f1b2c8b1f8c1b2c8',
      contentType: 'image/png',
      size: 1024,
      uploadedAt,
    });
    expect(result.screenshots[1]).toEqual({
      fileId: '60d5ec49f1b2c8b1f8c1b2c9',
      contentType: 'image/jpeg',
      size: 2048,
      uploadedAt,
    });
  });

  it('unwraps toObject and maps screenshot fileIds', () => {
    const uploadedAt = new Date('2026-01-05T10:00:00.000Z');
    const wrapper = {
      toObject: () => ({
        id: 'entry-10',
        createdAt,
        screenshots: [
          {
            fileId: { toString: () => '60d5ec49f1b2c8b1f8c1b2ca' },
            contentType: 'image/webp' as const,
            size: 512,
            uploadedAt,
          },
        ],
      }),
    };
    const result = serializeJournalEntry(wrapper);
    expect(result.screenshots).toEqual([
      {
        fileId: '60d5ec49f1b2c8b1f8c1b2ca',
        contentType: 'image/webp',
        size: 512,
        uploadedAt,
      },
    ]);
  });
});
