import { describe, expect, it } from 'vitest';

import { LAB_FORWARD_V1_LOCK } from './lab-forward-v1';
import { LEDGER, ledgerTotal } from './ledger';

describe('ledger', () => {
  it('returns the running total, 2189 after next-version Round 1', () => {
    expect(ledgerTotal()).toBe(2189);
  });

  it('matches baseline trials to LAB_FORWARD_V1_LOCK.ledgerAfter', () => {
    const baseline = LEDGER.find((entry) => entry.id === 'baseline-2026-10-18');
    expect(baseline).toBeDefined();
    expect(baseline?.trials).toBe(LAB_FORWARD_V1_LOCK.ledgerAfter);
  });

  it('validates every entry schema and constraints', () => {
    const ids = LEDGER.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const entry of LEDGER) {
      expect(entry.id.trim().length).toBeGreaterThan(0);
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isInteger(entry.trials)).toBe(true);
      expect(entry.trials).toBeGreaterThan(0);
      expect(entry.source.trim().length).toBeGreaterThan(0);
    }
  });

  it('ensures dates never decrease along the array', () => {
    for (let i = 1; i < LEDGER.length; i++) {
      expect(LEDGER[i].date >= LEDGER[i - 1].date).toBe(true);
    }
  });

  it('calculates total through specific entry and throws on unknown entry', () => {
    expect(ledgerTotal('baseline-2026-10-18')).toBe(2169);
    expect(() => ledgerTotal('nope')).toThrow('unknown ledger entry: nope');
  });
});
