// @vitest-environment node
import { describe, expect, it, vi, type Mock } from 'vitest';
import { createHash } from 'crypto';

import type { FundingFlag, ResolutionEntry } from './rv-panel';
import {
  REST_NEIGHBOUR_WINDOW_MS,
  assertVerified,
  draftResolutions,
  parseResolutions,
  serializeResolutions,
  verifyResolutions,
  type FundingFetcher,
} from './rv-resolutions';

const H = 3_600_000;
const T = Date.UTC(2022, 10, 10, 2); // SOLUSDT 2022-11-10 02:00, the A6-1 shortening switch
const flag = (symbol = 'SOLUSDT', t = T): FundingFlag => ({ symbol, t, reason: 'missing' });

/** A REST stand-in serving fixed settlement times per symbol, filtered to the requested range like Binance. */
function restWith(times: Record<string, number[]>): Mock<FundingFetcher> {
  return vi.fn<FundingFetcher>(async (symbol: string, startTime: number, endTime: number) =>
    (times[symbol] ?? []).filter((t) => t >= startTime && t <= endTime).map((fundingTime) => ({ symbol, fundingTime, fundingRate: 0.0001, markPrice: 1 }))
  );
}

describe('draftResolutions (proposes no-event entries from REST, never decides a flag REST contradicts)', () => {
  it('drafts a no-event entry with the REST settlement times either side when REST has none at the instant', async () => {
    // REST stamps settlements a few ms after the boundary on old rows, so times are read to the hour
    const rest = restWith({ SOLUSDT: [T - 10 * H + 3, T - 2 * H + 5, T + 2 * H + 1, T + 4 * H] });
    const { entries, unresolved } = await draftResolutions([flag()], rest);
    expect(entries).toEqual([{ symbol: 'SOLUSDT', t: T, verdict: 'no-event', restBefore: T - 2 * H, restAfter: T + 2 * H }]);
    expect(unresolved).toEqual([]);
    expect(rest).toHaveBeenCalledWith('SOLUSDT', T - REST_NEIGHBOUR_WINDOW_MS, T + REST_NEIGHBOUR_WINDOW_MS);
    expect(REST_NEIGHBOUR_WINDOW_MS).toBe(24 * H);
  });

  it('leaves a flag unresolved when REST shows a settlement there, when the fetch fails, or when a neighbour is absent', async () => {
    const shown = await draftResolutions([flag()], restWith({ SOLUSDT: [T - 4 * H, T + 2, T + 4 * H] }));
    expect(shown.entries).toEqual([]);
    expect(shown.unresolved).toEqual([{ flag: flag(), reason: expect.stringMatching(/REST shows a settlement/) }]);

    const failing: FundingFetcher = vi.fn(async () => {
      throw new Error('HTTP 451');
    });
    const failed = await draftResolutions([flag()], failing);
    expect(failed.entries).toEqual([]);
    expect(failed.unresolved[0].reason).toMatch(/fetch failed[\s\S]*HTTP 451/);

    const lonely = await draftResolutions([flag()], restWith({ SOLUSDT: [T - 4 * H] }));
    expect(lonely.entries).toEqual([]);
    expect(lonely.unresolved[0].reason).toMatch(/no REST settlement after/);
  });

  it('handles each flag on its own, keeping the input order', async () => {
    const rest = restWith({ SOLUSDT: [T - 4 * H, T + 4 * H], DOGEUSDT: [T + 2 * H - 1, T + 6 * H, T + 10 * H] });
    const doge = flag('DOGEUSDT', T + 2 * H);
    const { entries, unresolved } = await draftResolutions([flag(), doge], rest);
    expect(entries.map((e) => e.symbol)).toEqual(['SOLUSDT']);
    expect(unresolved.map((u) => u.flag)).toEqual([doge]);
  });
});

describe('verifyResolutions (the inputs stage re-queries REST for every entry, AMENDMENT 1)', () => {
  const entry = { symbol: 'SOLUSDT', t: T, verdict: 'no-event', restBefore: T - 2 * H, restAfter: T + 2 * H };
  const file = (entries: ResolutionEntry[]) => ({ sha256: 'a'.repeat(64), entries });

  it('passes when REST still has no settlement at the instant and the same neighbours, returning a frozen verified value', async () => {
    const out = await verifyResolutions(file([entry]), restWith({ SOLUSDT: [T - 2 * H + 4, T + 2 * H] }));
    expect(out).toEqual({ sha256: 'a'.repeat(64), entries: [entry] });
    expect(Object.isFrozen(out) && Object.isFrozen(out.entries) && Object.isFrozen(out.entries[0])).toBe(true);
    expect(() => assertVerified(out)).not.toThrow();
    expect(() => assertVerified({ ...out })).toThrow(/HALT[\s\S]*not verified/);
  });

  it('checks every entry, not only the first (review m11)', async () => {
    const second = { symbol: 'DOGEUSDT', t: T + 4 * H, verdict: 'no-event', restBefore: T, restAfter: T + 8 * H };
    const rest = restWith({ SOLUSDT: [T - 2 * H, T + 2 * H], DOGEUSDT: [T, T + 4 * H, T + 8 * H] });
    await expect(verifyResolutions(file([entry, second]), rest)).rejects.toThrow(/HALT[\s\S]*REST shows a settlement[\s\S]*DOGEUSDT/);
  });

  it('halts when REST shows a settlement at the instant', async () => {
    await expect(verifyResolutions(file([entry]), restWith({ SOLUSDT: [T - 2 * H, T, T + 2 * H] }))).rejects.toThrow(/HALT[\s\S]*REST shows a settlement[\s\S]*SOLUSDT/);
  });

  it('halts when REST cannot be reached', async () => {
    const failing: FundingFetcher = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(verifyResolutions(file([entry]), failing)).rejects.toThrow(/HALT[\s\S]*REST cannot be reached[\s\S]*ECONNRESET/);
  });

  it('halts when the recorded neighbours differ from REST', async () => {
    await expect(verifyResolutions(file([entry]), restWith({ SOLUSDT: [T - 4 * H, T + 2 * H] }))).rejects.toThrow(/HALT[\s\S]*neighbours/);
    await expect(verifyResolutions(file([entry]), restWith({ SOLUSDT: [T - 2 * H, T + 6 * H] }))).rejects.toThrow(/HALT[\s\S]*neighbours/);
  });

  it('halts on a verdict other than no-event', async () => {
    await expect(verifyResolutions(file([{ ...entry, verdict: 'rest' }]), restWith({ SOLUSDT: [T - 2 * H, T + 2 * H] }))).rejects.toThrow(/HALT[\s\S]*verdict/);
  });
});

describe('the resolutions file (one recorded format, hashed as read)', () => {
  const entries = [{ symbol: 'SOLUSDT', t: T, verdict: 'no-event', restBefore: T - 2 * H, restAfter: T + 2 * H }];

  it('round-trips through ISO times and records the sha256 of the text as read', () => {
    const text = serializeResolutions(entries);
    expect(JSON.parse(text)).toEqual({
      resolutions: [{ symbol: 'SOLUSDT', t: '2022-11-10T02:00:00.000Z', verdict: 'no-event', restBefore: '2022-11-10T00:00:00.000Z', restAfter: '2022-11-10T04:00:00.000Z' }],
    });
    expect(parseResolutions(text)).toEqual({ sha256: createHash('sha256').update(text).digest('hex'), entries });
  });

  it('rejects a time that is not a canonical ISO instant and a malformed file', () => {
    const bad = serializeResolutions(entries).replace('2022-11-10T02:00:00.000Z', '2022-11-10 02:00');
    expect(() => parseResolutions(bad)).toThrow(/ISO/);
    expect(() => parseResolutions('{"resolutions":[{"symbol":"X"}]}')).toThrow();
  });
});
