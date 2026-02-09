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

  it('rejects notes over 1000 chars', () => {
    const result = createJournalEntrySchema.safeParse({ ...valid, notes: 'a'.repeat(1001) });
    expect(result.success).toBe(false);
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
});
