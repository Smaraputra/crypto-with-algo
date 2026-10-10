import { describe, expect, it } from 'vitest';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { SNIPE_DISCOVERY_CELLS, SNIPE_NULL, type SnipeTimeframe } from './snipe';
import {
  commitsAgree,
  confirmationBinding,
  confirmationSlice,
  discoveryBinding,
  discoverySlice,
  isCommitSet,
  sanityBinding,
} from './snipe-cli';
import { OUTCOME_UP } from './snipe-labels';
import type { SnipeSymbolArrays } from './snipe-matrix';
import { sliceView } from './snipe-stats';

describe('slice bounds (A1-7)', () => {
  it('discovery starts at 2022-01-01 and ends 1 ms before the confirmation start', () => {
    const s = discoverySlice();
    expect(new Date(s.startMs).toISOString()).toBe('2022-01-01T00:00:00.000Z');
    expect(new Date(s.endMs).toISOString()).toBe('2024-12-31T23:59:59.999Z');
  });

  it('confirmation starts at 2025-01-01 and ends 1 ms before the lockbox start', () => {
    const s = confirmationSlice();
    expect(new Date(s.startMs).toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(new Date(s.endMs).toISOString()).toBe('2026-06-30T23:59:59.999Z');
  });

  it('keeps the last bar whose trade window ends exactly at the slice end', () => {
    // The 1h bar at 2024-12-30T23:00 enters at 2024-12-31T00:00 and holds 24h: its last millisecond is
    // 2024-12-31T23:59:59.999Z. The second-rounded end 23:59:59 would have dropped it.
    const hour = 3_600_000;
    const day = 24 * hour;
    const t = Date.parse('2024-12-30T23:00:00Z');
    const arrays = {
      timestamps: Float64Array.of(t, t + hour),
      outcome: Int8Array.of(OUTCOME_UP, OUTCOME_UP),
      entryMs: Float64Array.of(t + hour, t + 2 * hour),
      atrQuintile: Int8Array.of(1, 1),
    } as unknown as SnipeSymbolArrays;
    const view = sliceView(arrays, discoverySlice(), day);
    expect(Array.from(view.idx)).toEqual([0]);
    const old = sliceView(arrays, { startMs: discoverySlice().startMs, endMs: Date.parse('2024-12-31T23:59:59Z') }, day);
    expect(Array.from(old.idx)).toEqual([]);
  });
});

describe('binding runs (A1-6)', () => {
  const both: SnipeTimeframe[] = ['scalp', 'intraday'];
  const symbols = [...SIGNAL_SYMBOLS];
  const commits = symbols.map(() => 'abc123');
  const discovery = {
    timeframes: both,
    symbols,
    draws: SNIPE_NULL.discoveryDraws,
    cells: SNIPE_DISCOVERY_CELLS,
    gitCommit: 'abc123',
    cacheCommits: commits,
  };

  it('treats unset and unknown commits as not set', () => {
    expect(isCommitSet('abc123')).toBe(true);
    expect(isCommitSet('unknown')).toBe(false);
    expect(isCommitSet('')).toBe(false);
    expect(commitsAgree('abc123', commits)).toBe(true);
    expect(commitsAgree('abc123', [])).toBe(false);
    expect(commitsAgree('abc123', [...commits.slice(1), 'other'])).toBe(false);
    expect(commitsAgree('unknown', ['unknown'])).toBe(false);
  });

  it('makes discovery binding only with every condition', () => {
    expect(discoveryBinding(discovery)).toBe(true);
    expect(discoveryBinding({ ...discovery, timeframes: ['intraday'] })).toBe(false);
    expect(discoveryBinding({ ...discovery, timeframes: ['intraday', 'scalp'] })).toBe(false);
    expect(discoveryBinding({ ...discovery, symbols: symbols.slice(0, 9) })).toBe(false);
    expect(discoveryBinding({ ...discovery, symbols: [...symbols].reverse() })).toBe(false);
    expect(discoveryBinding({ ...discovery, draws: 20 })).toBe(false);
    expect(discoveryBinding({ ...discovery, cells: 152 })).toBe(false);
    expect(discoveryBinding({ ...discovery, gitCommit: 'unknown', cacheCommits: symbols.map(() => 'unknown') })).toBe(false);
    expect(discoveryBinding({ ...discovery, gitCommit: '', cacheCommits: symbols.map(() => '') })).toBe(false);
    expect(discoveryBinding({ ...discovery, cacheCommits: [...commits.slice(1), 'other'] })).toBe(false);
  });

  it('makes the sanity report binding on the base conditions only', () => {
    const base = { timeframes: both, symbols, gitCommit: 'abc123', cacheCommits: commits };
    expect(sanityBinding(base)).toBe(true);
    expect(sanityBinding({ ...base, timeframes: ['scalp'] })).toBe(false);
    expect(sanityBinding({ ...base, gitCommit: 'unknown' })).toBe(false);
  });

  it('makes confirmation binding only after a binding discovery with the same commit and symbols', () => {
    const run = {
      discovery: { binding: true, gitCommit: 'abc123', symbols },
      symbols,
      draws: SNIPE_NULL.confirmationDraws,
      gitCommit: 'abc123',
      cacheCommits: commits,
    };
    expect(confirmationBinding(run)).toBe(true);
    expect(confirmationBinding({ ...run, discovery: { ...run.discovery, binding: false } })).toBe(false);
    expect(confirmationBinding({ ...run, discovery: { ...run.discovery, binding: undefined } })).toBe(false);
    expect(confirmationBinding({ ...run, draws: 100 })).toBe(false);
    expect(confirmationBinding({ ...run, symbols: symbols.slice(1) })).toBe(false);
    expect(confirmationBinding({ ...run, discovery: { ...run.discovery, gitCommit: 'other' } })).toBe(false);
    expect(confirmationBinding({ ...run, cacheCommits: [...commits.slice(1), 'other'] })).toBe(false);
    expect(
      confirmationBinding({ ...run, gitCommit: 'unknown', discovery: { ...run.discovery, gitCommit: 'unknown' }, cacheCommits: ['unknown'] })
    ).toBe(false);
  });
});
