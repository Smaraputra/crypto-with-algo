import { describe, it, expect } from 'vitest';
import {
  createResearchNoteSchema,
  updateResearchNoteSchema,
  RESEARCH_NOTE_CATEGORIES,
} from './research-note';

describe('createResearchNoteSchema', () => {
  it('accepts valid input', () => {
    const result = createResearchNoteSchema.safeParse({
      title: 'Test note',
      content: 'Some content',
      category: 'strategy',
      tags: ['tag1'],
      relatedSymbols: ['BTCUSDT'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts minimal input', () => {
    const result = createResearchNoteSchema.safeParse({
      title: 'Minimal',
      category: 'rule',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty title', () => {
    const result = createResearchNoteSchema.safeParse({
      title: '',
      category: 'rule',
    });
    expect(result.success).toBe(false);
  });

  it('rejects title over 200 chars', () => {
    const result = createResearchNoteSchema.safeParse({
      title: 'x'.repeat(201),
      category: 'rule',
    });
    expect(result.success).toBe(false);
  });

  it('accepts 200-char title', () => {
    const result = createResearchNoteSchema.safeParse({
      title: 'x'.repeat(200),
      category: 'rule',
    });
    expect(result.success).toBe(true);
  });

  it('rejects content over 50000 chars', () => {
    const result = createResearchNoteSchema.safeParse({
      title: 'Note',
      category: 'concept',
      content: 'x'.repeat(50001),
    });
    expect(result.success).toBe(false);
  });

  it('accepts 50000-char content', () => {
    const result = createResearchNoteSchema.safeParse({
      title: 'Note',
      category: 'concept',
      content: 'x'.repeat(50000),
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid category', () => {
    const result = createResearchNoteSchema.safeParse({
      title: 'Note',
      category: 'invalid',
    });
    expect(result.success).toBe(false);
  });

  it('accepts all valid categories', () => {
    for (const category of RESEARCH_NOTE_CATEGORIES) {
      const result = createResearchNoteSchema.safeParse({
        title: 'Note',
        category,
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects more than 20 tags', () => {
    const result = createResearchNoteSchema.safeParse({
      title: 'Note',
      category: 'rule',
      tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`),
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 10 related symbols', () => {
    const result = createResearchNoteSchema.safeParse({
      title: 'Note',
      category: 'rule',
      relatedSymbols: Array.from({ length: 11 }, (_, i) => `SYM${i}USDT`),
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing category', () => {
    const result = createResearchNoteSchema.safeParse({
      title: 'Note',
    });
    expect(result.success).toBe(false);
  });
});

describe('updateResearchNoteSchema', () => {
  it('accepts partial update', () => {
    const result = updateResearchNoteSchema.safeParse({
      title: 'Updated title',
    });
    expect(result.success).toBe(true);
  });

  it('accepts empty update', () => {
    const result = updateResearchNoteSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts isPinned update', () => {
    const result = updateResearchNoteSchema.safeParse({
      isPinned: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid category in update', () => {
    const result = updateResearchNoteSchema.safeParse({
      category: 'invalid',
    });
    expect(result.success).toBe(false);
  });
});
