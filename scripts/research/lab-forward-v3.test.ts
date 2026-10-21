// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { LAB_FORWARD_V3_LOCK as LOCK } from './lab-forward-v3';
import { hashUniverseManifest } from './nv2-universe';
import {
  LAB_HYPOTHESES_V3,
  LAB_TIMEFRAME_MS,
  LAB_V3_COST_PER_SIDE,
  LAB_V3_COST_UNRANKED,
  LAB_V3_DELISTING_HAIRCUT,
  LAB_V3_TAKER_FEE,
  LAB_V3_THRESHOLD,
  LAB_V3_UNIVERSE,
  LAB_V3_UNIVERSE_SHA256,
  LAB_VERSION_V3,
  labDelayMs,
  labV3SlippageOfRank,
} from '@/lib/signals/lab/candidates';
import { initialEState } from '@/lib/signals/lab/e-process';
import { gradeBookBar } from '@/lib/signals/lab/job-grade';
import { MIN_SCORED_COINS, MIN_SETTLEMENTS_7D, STAGGER_DAYS } from '@/lib/signals/lab/v3/f1';

const F1_HYP = LAB_HYPOTHESES_V3.find((h) => h.id === 'F1-1d')!;

describe('lab-v3 lock', () => {
  it('freezes version, hypothesis, scale, threshold and universe', () => {
    expect(LAB_VERSION_V3).toBe(LOCK.version);
    expect(
      LAB_HYPOTHESES_V3.map((h) => ({
        id: h.id,
        candidate: h.candidate,
        timeframe: h.timeframe,
        metric: h.metric,
        scale: h.scale,
      }))
    ).toEqual(LOCK.hypotheses);
    for (const h of LAB_HYPOTHESES_V3) expect(h.version).toBe(LOCK.version);
    expect(LAB_V3_THRESHOLD).toBe(LOCK.threshold);
    expect(LOCK.threshold).toBeCloseTo(1 / LOCK.alphaPerSlot, 10);
    expect(LAB_V3_UNIVERSE).toEqual(LOCK.universe);
    expect(LAB_V3_UNIVERSE_SHA256).toBe(LOCK.universeSha256);
    expect(LAB_V3_UNIVERSE.length).toBe(30);
  });

  it('freezes timing: 1d bars, 10m execution delay', () => {
    expect(LAB_TIMEFRAME_MS['1d']).toBe(86_400_000);
    expect(labDelayMs('1d')).toBe(LOCK.delayMs);
    expect(LOCK.delayMs).toBe(600_000);
  });

  it('freezes F1 candidate constants', () => {
    expect(STAGGER_DAYS).toBe(LOCK.f1.staggerDays);
    expect(MIN_SETTLEMENTS_7D).toBe(LOCK.f1.minSettlements7d);
    expect(MIN_SCORED_COINS).toBe(LOCK.f1.minScoredCoins);
  });

  it('freezes fee, slippage tiers, unranked cost and delisting haircut', () => {
    expect(LAB_V3_TAKER_FEE).toBe(LOCK.f1.takerFee);
    expect(labV3SlippageOfRank(1)).toBe(LOCK.f1.slippageByRank.rank1to10);
    expect(labV3SlippageOfRank(10)).toBe(LOCK.f1.slippageByRank.rank1to10);
    expect(labV3SlippageOfRank(11)).toBe(LOCK.f1.slippageByRank.rank11to25);
    expect(labV3SlippageOfRank(25)).toBe(LOCK.f1.slippageByRank.rank11to25);
    expect(labV3SlippageOfRank(26)).toBe(LOCK.f1.slippageByRank.rank26to30);
    expect(labV3SlippageOfRank(30)).toBe(LOCK.f1.slippageByRank.rank26to30);
    expect(LAB_V3_COST_UNRANKED).toBe(LOCK.f1.costUnranked);
    expect(LAB_V3_DELISTING_HAIRCUT).toBe(LOCK.f1.delistingHaircut);
  });

  it('manifest file matches universe, ranks and hash', () => {
    const raw = readFileSync(LOCK.manifestFile, 'utf8');
    const manifest = JSON.parse(raw) as {
      members: Array<{ rank: number; symbol: string }>;
      sha256: string;
      [key: string]: unknown;
    };

    expect(manifest.members.map((m) => m.symbol)).toEqual(LAB_V3_UNIVERSE);
    manifest.members.forEach((m, idx) => {
      expect(m.rank).toBe(idx + 1);
    });
    expect(manifest.sha256).toBe(LAB_V3_UNIVERSE_SHA256);
    expect(hashUniverseManifest(manifest)).toBe(LAB_V3_UNIVERSE_SHA256);

    for (const m of manifest.members) {
      const expectedCost = LOCK.f1.takerFee + labV3SlippageOfRank(m.rank);
      expect(LAB_V3_COST_PER_SIDE[m.symbol]).toBeCloseTo(expectedCost, 12);
    }
  });

  it('golden vector: F1 net book return with funding and tiered turnover cost', () => {
    const prev = {
      state: initialEState(),
      weights: { BTCUSDT: 0.25, PENGUUSDT: -0.25 } as Record<string, number>,
    };
    const weights = { BTCUSDT: 0.5, UNIUSDT: -0.25, PENGUUSDT: -0.25 };
    const prices = {
      BTCUSDT: { start: 100, end: 102 },
      UNIUSDT: { start: 10, end: 11 },
      PENGUUSDT: { start: 1, end: 0.9 },
    };
    const fundingSums = {
      BTCUSDT: 0.001,
      UNIUSDT: 0.0005,
      PENGUUSDT: -0.001,
    };

    const cost = 0.25 * 0.0007 + 0.25 * 0.001;
    const grossReturnFunding =
      0.5 * (102 / 100 - 1 - 0.001) +
      (-0.25) * (11 / 10 - 1 - 0.0005) +
      (-0.25) * (0.9 / 1 - 1 - (-0.001));
    const expectedR = grossReturnFunding - cost;
    const expectedX = Math.min(expectedR / 0.036, 1);

    const row = gradeBookBar({
      hypothesis: F1_HYP,
      barClose: Date.UTC(2026, 9, 20),
      gradedAt: new Date(Date.UTC(2026, 9, 21, 1)),
      late: false,
      scores: weights,
      prices,
      fundingSums,
      prev,
    } as Parameters<typeof gradeBookBar>[0]);

    expect(row.netBookReturn).toBeCloseTo(expectedR, 12);
    expect(row.x).toBeCloseTo(expectedX, 12);
    expect(row.b).toBe(0);
    expect(row.version).toBe('lab-v3');
    expect(row.hypothesis).toBe('F1-1d');
  });

  it('golden vector: grading crosses at threshold 200', () => {
    let state = initialEState();
    let crossedAt: number | null = null;
    const base = Date.UTC(2026, 9, 20);

    for (let i = 0; i < 200 && crossedAt === null; i++) {
      const row = gradeBookBar({
        hypothesis: F1_HYP,
        barClose: base + i * 86_400_000,
        gradedAt: new Date(base + (i + 1) * 86_400_000),
        late: false,
        scores: { BTCUSDT: 0.5, ETHUSDT: -0.5 },
        prices: {
          BTCUSDT: { start: 100, end: 100 * (1 + 0.036 * 0.4 + 0.0007) },
          ETHUSDT: { start: 100, end: 100 * (1 - 0.036 * 0.4 - 0.0007) },
        },
        fundingSums: { BTCUSDT: 0, ETHUSDT: 0 },
        prev: { state, weights: {} },
      } as Parameters<typeof gradeBookBar>[0]);
      state = row.state;
      crossedAt = state.crossedAt;
    }

    expect(crossedAt).not.toBeNull();
    expect(state.logE).toBeGreaterThanOrEqual(Math.log(200));
    expect(state.logE).toBeLessThan(Math.log(400) + 1);
  });
});
