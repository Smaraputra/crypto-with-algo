import { describe, it, expect } from 'vitest';
import { createJournalEntrySchema, updateJournalEntrySchema } from './journal';

describe('createJournalEntrySchema', () => {
  const valid = {
    symbol: 'BTCUSDT',
    interval: '1h',
    signalScore: 45,
    signalTier: 'buy' as const,
    action: 'buy' as const,
    entryPrice: 42000,
    notes: 'Momentum signal',
  };

  it('accepts valid input', () => {
    const result = createJournalEntrySchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('accepts input without optional fields', () => {
    const { entryPrice, notes, ...required } = valid;
    void entryPrice;
    void notes;
    const result = createJournalEntrySchema.safeParse(required);
    expect(result.success).toBe(true);
  });

  it('rejects empty symbol', () => {
    const result = createJournalEntrySchema.safeParse({ ...valid, symbol: '' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid signal tier', () => {
    const result = createJournalEntrySchema.safeParse({ ...valid, signalTier: 'invalid' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid action', () => {
    const result = createJournalEntrySchema.safeParse({ ...valid, action: 'panic' });
    expect(result.success).toBe(false);
  });

  it('rejects score out of range', () => {
    const result = createJournalEntrySchema.safeParse({ ...valid, signalScore: 200 });
    expect(result.success).toBe(false);
  });

  it('rejects negative entry price', () => {
    const result = createJournalEntrySchema.safeParse({ ...valid, entryPrice: -100 });
    expect(result.success).toBe(false);
  });

  it('rejects notes over 10000 chars', () => {
    const result = createJournalEntrySchema.safeParse({ ...valid, notes: 'a'.repeat(10001) });
    expect(result.success).toBe(false);
  });

  it('accepts notes up to 10000 chars', () => {
    const result = createJournalEntrySchema.safeParse({ ...valid, notes: 'a'.repeat(10000) });
    expect(result.success).toBe(true);
  });

  it('accepts tags array', () => {
    const result = createJournalEntrySchema.safeParse({ ...valid, tags: ['breakout', 'trend-follow'] });
    expect(result.success).toBe(true);
  });

  it('rejects too many tags', () => {
    const tags = Array.from({ length: 21 }, (_, i) => `tag-${i}`);
    const result = createJournalEntrySchema.safeParse({ ...valid, tags });
    expect(result.success).toBe(false);
  });

  it('accepts market condition', () => {
    const result = createJournalEntrySchema.safeParse({ ...valid, marketCondition: 'trending_up' });
    expect(result.success).toBe(true);
  });

  it('rejects invalid market condition', () => {
    const result = createJournalEntrySchema.safeParse({ ...valid, marketCondition: 'sideways' });
    expect(result.success).toBe(false);
  });

  it('accepts sentiment data', () => {
    const result = createJournalEntrySchema.safeParse({
      ...valid,
      sentiment: { fearGreedIndex: 65, fearGreedLabel: 'Greed' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects sentiment with out-of-range index', () => {
    const result = createJournalEntrySchema.safeParse({
      ...valid,
      sentiment: { fearGreedIndex: 150, fearGreedLabel: 'Invalid' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts setup type', () => {
    const result = createJournalEntrySchema.safeParse({ ...valid, setupType: 'breakout' });
    expect(result.success).toBe(true);
  });

  it('accepts indicator snapshot', () => {
    const result = createJournalEntrySchema.safeParse({
      ...valid,
      indicatorSnapshot: { rsi: 62, macdLine: 150 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts all journal actions', () => {
    for (const action of ['buy', 'sell', 'hold', 'skip'] as const) {
      const result = createJournalEntrySchema.safeParse({ ...valid, action });
      expect(result.success).toBe(true);
    }
  });

  it('accepts all signal tiers', () => {
    for (const tier of ['strong_buy', 'buy', 'neutral', 'sell', 'strong_sell'] as const) {
      const result = createJournalEntrySchema.safeParse({ ...valid, signalTier: tier });
      expect(result.success).toBe(true);
    }
  });
});

describe('updateJournalEntrySchema', () => {
  it('accepts partial update with exitPrice', () => {
    const result = updateJournalEntrySchema.safeParse({ exitPrice: 43000 });
    expect(result.success).toBe(true);
  });

  it('accepts partial update with notes', () => {
    const result = updateJournalEntrySchema.safeParse({ notes: 'Updated notes' });
    expect(result.success).toBe(true);
  });

  it('accepts reviewedAt as date string', () => {
    const result = updateJournalEntrySchema.safeParse({ reviewedAt: '2025-01-01T00:00:00.000Z' });
    expect(result.success).toBe(true);
  });

  it('rejects negative exit price', () => {
    const result = updateJournalEntrySchema.safeParse({ exitPrice: -100 });
    expect(result.success).toBe(false);
  });

  it('accepts lessons learned', () => {
    const result = updateJournalEntrySchema.safeParse({ lessonsLearned: 'Should have waited' });
    expect(result.success).toBe(true);
  });

  it('rejects lessons learned over 10000 chars', () => {
    const result = updateJournalEntrySchema.safeParse({ lessonsLearned: 'a'.repeat(10001) });
    expect(result.success).toBe(false);
  });

  it('accepts tags update', () => {
    const result = updateJournalEntrySchema.safeParse({ tags: ['breakout'] });
    expect(result.success).toBe(true);
  });

  it('accepts setup type update', () => {
    const result = updateJournalEntrySchema.safeParse({ setupType: 'reversal' });
    expect(result.success).toBe(true);
  });

  it('accepts market condition update', () => {
    const result = updateJournalEntrySchema.safeParse({ marketCondition: 'volatile' });
    expect(result.success).toBe(true);
  });

  it('accepts sentiment update', () => {
    const result = updateJournalEntrySchema.safeParse({
      sentiment: { fearGreedIndex: 25, fearGreedLabel: 'Fear' },
    });
    expect(result.success).toBe(true);
  });
});
