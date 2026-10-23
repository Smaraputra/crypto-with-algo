import { describe, expect, it } from 'vitest';
import { coinEvidence } from './coin-evidence';
import type {
  LabHypothesisView,
  LabResponse,
  LabV2HypothesisView,
  LabV2Response,
  LabV3HypothesisView,
  LabV3Response,
  LabV4HypothesisView,
  LabV4Response,
} from './view';

function makeLabV1Hypothesis(overrides?: Partial<LabHypothesisView>): LabHypothesisView {
  return {
    id: 'L1-8h',
    candidate: 'L1',
    timeframe: '8h',
    status: 'under_test',
    underTestSince: '2026-01-01T00:00:00.000Z',
    testEndsAt: '2028-01-01T00:00:00.000Z',
    validatedAt: null,
    gradedBars: 100,
    betBars: 90,
    e: 1.84,
    e0: 0.5,
    threshold: 800,
    meanX: 0.05,
    meanB: 0.04,
    currentB: 0.03,
    latestBar: {
      barClose: '2026-10-23T08:00:00.000Z',
      late: false,
      coins: [
        { symbol: 'BTCUSDT', score: 90, rank: 1 },
        { symbol: 'DOTUSDT', score: 70, rank: 2 },
      ],
      skipped: [],
    },
    ...overrides,
  };
}

function makeLabV2Hypothesis(overrides?: Partial<LabV2HypothesisView>): LabV2HypothesisView {
  return {
    id: 'N2-1d',
    candidate: 'N2',
    timeframe: '1d',
    status: 'validated',
    underTestSince: '2026-01-01T00:00:00.000Z',
    testEndsAt: '2028-01-01T00:00:00.000Z',
    validatedAt: '2026-06-01T00:00:00.000Z',
    gradedBars: 120,
    betBars: 100,
    e: 100,
    threshold: 200,
    absorbed: false,
    meanNetReturn: 0.02,
    lastNetReturn: 0.015,
    scale: 0.13,
    latestBar: {
      barClose: '2026-10-23T00:00:00.000Z',
      late: false,
      positions: [{ symbol: 'BTCUSDT', weight: 0.05 }],
      cash: false,
    },
    ...overrides,
  };
}

function makeLabV3Hypothesis(overrides?: Partial<LabV3HypothesisView>): LabV3HypothesisView {
  return {
    id: 'F1-1d',
    candidate: 'F1',
    timeframe: '1d',
    status: 'under_test',
    underTestSince: '2026-02-01T00:00:00.000Z',
    testEndsAt: '2028-02-01T00:00:00.000Z',
    validatedAt: null,
    gradedBars: 80,
    betBars: 70,
    e: 50,
    threshold: 200,
    absorbed: false,
    meanNetReturn: 0.018,
    lastNetReturn: 0.012,
    scale: 0.036,
    latestBar: {
      barClose: '2026-10-23T00:00:00.000Z',
      late: false,
      positions: [{ symbol: 'BTCUSDT', weight: 0.064 }],
      cash: false,
    },
    ...overrides,
  };
}

function makeLabV4Hypothesis(overrides?: Partial<LabV4HypothesisView>): LabV4HypothesisView {
  return {
    id: 'S1-1h',
    candidate: 'S1',
    timeframe: '1h',
    status: 'under_test',
    underTestSince: '2026-03-01T00:00:00.000Z',
    testEndsAt: '2028-03-01T00:00:00.000Z',
    validatedAt: null,
    gradedBars: 200,
    betBars: 50,
    e: 2.0,
    threshold: 800,
    absorbed: false,
    meanNetReturn: 0.005,
    lastNetReturn: 0.004,
    scale: 0.15,
    openTrades: [
      {
        symbol: 'BTCUSDT',
        side: 1,
        enteredAt: '2026-10-23T06:10:00.000Z',
        exitsAt: '2026-10-23T14:10:00.000Z',
      },
    ],
    latestBar: {
      barClose: '2026-10-23T07:00:00.000Z',
      late: false,
      entries: [{ symbol: 'BTCUSDT', side: 1 }],
    },
    ...overrides,
  };
}

describe('coinEvidence', () => {
  it('assigns not_in_universe for lab-v3 when coin is outside LAB_V3_UNIVERSE, and real positions elsewhere', () => {
    // DOTUSDT is in SIGNAL_SYMBOLS (the 10 coins), but outside LAB_V3_UNIVERSE (the 30 coins)
    const exitTimestamp = new Date('2026-10-23T14:10:00.000Z').getTime();
    const v1: LabResponse = {
      version: 'lab-v1',
      threshold: 800,
      hypotheses: [makeLabV1Hypothesis({ id: 'L1-8h' })],
    };
    const v2: LabV2Response = {
      version: 'lab-v2',
      threshold: 200,
      hypotheses: [
        makeLabV2Hypothesis({
          id: 'N2-1d',
          latestBar: {
            barClose: '2026-10-23T00:00:00.000Z',
            late: false,
            positions: [{ symbol: 'DOTUSDT', weight: 0.08 }],
            cash: false,
          },
        }),
      ],
    };
    const v3: LabV3Response = {
      version: 'lab-v3',
      threshold: 200,
      hypotheses: [
        makeLabV3Hypothesis({
          id: 'F1-1d',
          latestBar: {
            barClose: '2026-10-23T00:00:00.000Z',
            late: false,
            positions: [{ symbol: 'DOTUSDT', weight: 0.08 }],
            cash: false,
          },
        }),
      ],
    };
    const v4: LabV4Response = {
      version: 'lab-v4',
      threshold: 800,
      hypotheses: [
        makeLabV4Hypothesis({
          id: 'S1-1h',
          openTrades: [
            {
              symbol: 'DOTUSDT',
              side: 1,
              enteredAt: '2026-10-23T06:10:00.000Z',
              exitsAt: '2026-10-23T14:10:00.000Z',
            },
          ],
        }),
      ],
    };

    const rows = coinEvidence('DOTUSDT', { v1, v2, v3, v4 });

    const rowV3 = rows.find((r) => r.lab === 'lab-v3');
    const rowV2 = rows.find((r) => r.lab === 'lab-v2');
    const rowV4 = rows.find((r) => r.lab === 'lab-v4');
    const rowV1 = rows.find((r) => r.lab === 'lab-v1');

    expect(rowV3).toBeDefined();
    expect(rowV3?.position).toEqual({ kind: 'not_in_universe' });

    expect(rowV2).toBeDefined();
    expect(rowV2?.position).toEqual({ kind: 'long', weight: 0.08 });

    expect(rowV4).toBeDefined();
    expect(rowV4?.position).toEqual({ kind: 'long', until: exitTimestamp });

    expect(rowV1).toBeDefined();
    expect(rowV1?.position).toEqual({ kind: 'flat' });
  });

  it('marks coin outside SIGNAL_SYMBOLS as not_in_universe across labs', () => {
    const v1: LabResponse = {
      version: 'lab-v1',
      threshold: 800,
      hypotheses: [makeLabV1Hypothesis()],
    };
    const v2: LabV2Response = {
      version: 'lab-v2',
      threshold: 200,
      hypotheses: [makeLabV2Hypothesis()],
    };
    const v3: LabV3Response = {
      version: 'lab-v3',
      threshold: 200,
      hypotheses: [makeLabV3Hypothesis()],
    };
    const v4: LabV4Response = {
      version: 'lab-v4',
      threshold: 800,
      hypotheses: [makeLabV4Hypothesis()],
    };

    const rows = coinEvidence('UNKNOWNUSDT', { v1, v2, v3, v4 });

    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.position).toEqual({ kind: 'not_in_universe' });
    }
  });

  describe('weight dead band (0.0005)', () => {
    it('treats 0.0004 as flat and 0.0006 as long', () => {
      const v2: LabV2Response = {
        version: 'lab-v2',
        threshold: 200,
        hypotheses: [
          makeLabV2Hypothesis({
            id: 'N2-below',
            latestBar: {
              barClose: '2026-10-23T00:00:00.000Z',
              late: false,
              positions: [{ symbol: 'BTCUSDT', weight: 0.0004 }],
              cash: false,
            },
          }),
          makeLabV2Hypothesis({
            id: 'N2-above',
            latestBar: {
              barClose: '2026-10-23T00:00:00.000Z',
              late: false,
              positions: [{ symbol: 'BTCUSDT', weight: 0.0006 }],
              cash: false,
            },
          }),
        ],
      };

      const rows = coinEvidence('BTCUSDT', { v2 });
      const rowBelow = rows.find((r) => r.id === 'N2-below');
      const rowAbove = rows.find((r) => r.id === 'N2-above');

      expect(rowBelow?.position).toEqual({ kind: 'flat' });
      expect(rowAbove?.position).toEqual({ kind: 'long', weight: 0.0006 });
    });

    it('treats negative weights correctly: -0.0004 is flat, -0.0006 is short', () => {
      const v2: LabV2Response = {
        version: 'lab-v2',
        threshold: 200,
        hypotheses: [
          makeLabV2Hypothesis({
            id: 'N2-short-below',
            latestBar: {
              barClose: '2026-10-23T00:00:00.000Z',
              late: false,
              positions: [{ symbol: 'BTCUSDT', weight: -0.0004 }],
              cash: false,
            },
          }),
          makeLabV2Hypothesis({
            id: 'N2-short-above',
            latestBar: {
              barClose: '2026-10-23T00:00:00.000Z',
              late: false,
              positions: [{ symbol: 'BTCUSDT', weight: -0.0006 }],
              cash: false,
            },
          }),
        ],
      };

      const rows = coinEvidence('BTCUSDT', { v2 });
      const rowBelow = rows.find((r) => r.id === 'N2-short-below');
      const rowAbove = rows.find((r) => r.id === 'N2-short-above');

      expect(rowBelow?.position).toEqual({ kind: 'flat' });
      expect(rowAbove?.position).toEqual({ kind: 'short', weight: 0.0006 });
    });

    it('treats exact threshold 0.0005 as long', () => {
      const v2: LabV2Response = {
        version: 'lab-v2',
        threshold: 200,
        hypotheses: [
          makeLabV2Hypothesis({
            id: 'N2-edge',
            latestBar: {
              barClose: '2026-10-23T00:00:00.000Z',
              late: false,
              positions: [{ symbol: 'BTCUSDT', weight: 0.0005 }],
              cash: false,
            },
          }),
        ],
      };

      const rows = coinEvidence('BTCUSDT', { v2 });
      expect(rows[0]?.position).toEqual({ kind: 'long', weight: 0.0005 });
    });

    it('treats missing position in positions array as flat', () => {
      const v2: LabV2Response = {
        version: 'lab-v2',
        threshold: 200,
        hypotheses: [
          makeLabV2Hypothesis({
            id: 'N2-absent',
            latestBar: {
              barClose: '2026-10-23T00:00:00.000Z',
              late: false,
              positions: [{ symbol: 'ETHUSDT', weight: 0.1 }],
              cash: false,
            },
          }),
        ],
      };

      const rows = coinEvidence('BTCUSDT', { v2 });
      expect(rows[0]?.position).toEqual({ kind: 'flat' });
    });
  });

  describe('lab-v4 open trade', () => {
    it('yields long with until when trade side is 1', () => {
      const exitTimestamp = new Date('2026-10-23T14:10:00.000Z').getTime();
      const v4: LabV4Response = {
        version: 'lab-v4',
        threshold: 800,
        hypotheses: [
          makeLabV4Hypothesis({
            id: 'S1-1h',
            openTrades: [
              {
                symbol: 'BTCUSDT',
                side: 1,
                enteredAt: '2026-10-23T06:10:00.000Z',
                exitsAt: '2026-10-23T14:10:00.000Z',
              },
            ],
          }),
        ],
      };

      const rows = coinEvidence('BTCUSDT', { v4 });
      expect(rows[0]?.position).toEqual({ kind: 'long', until: exitTimestamp });
    });

    it('yields short with until when trade side is -1', () => {
      const exitTimestamp = new Date('2026-10-23T18:00:00.000Z').getTime();
      const v4: LabV4Response = {
        version: 'lab-v4',
        threshold: 800,
        hypotheses: [
          makeLabV4Hypothesis({
            id: 'S2-1h',
            candidate: 'S2',
            openTrades: [
              {
                symbol: 'BTCUSDT',
                side: -1,
                enteredAt: '2026-10-23T10:10:00.000Z',
                exitsAt: '2026-10-23T18:00:00.000Z',
              },
            ],
          }),
        ],
      };

      const rows = coinEvidence('BTCUSDT', { v4 });
      expect(rows[0]?.position).toEqual({ kind: 'short', until: exitTimestamp });
    });

    it('yields flat when coin has no open trade in openTrades', () => {
      const v4: LabV4Response = {
        version: 'lab-v4',
        threshold: 800,
        hypotheses: [
          makeLabV4Hypothesis({
            id: 'S1-1h',
            openTrades: [
              {
                symbol: 'ETHUSDT',
                side: 1,
                enteredAt: '2026-10-23T06:10:00.000Z',
                exitsAt: '2026-10-23T14:10:00.000Z',
              },
            ],
          }),
        ],
      };

      const rows = coinEvidence('BTCUSDT', { v4 });
      expect(rows[0]?.position).toEqual({ kind: 'flat' });
    });
  });

  describe('cash and no-bar cases', () => {
    it('yields cash when cash is true even if positions lists the coin', () => {
      const v3: LabV3Response = {
        version: 'lab-v3',
        threshold: 200,
        hypotheses: [
          makeLabV3Hypothesis({
            id: 'F1-1d',
            latestBar: {
              barClose: '2026-10-23T00:00:00.000Z',
              late: false,
              positions: [{ symbol: 'BTCUSDT', weight: 0.1 }],
              cash: true,
            },
          }),
        ],
      };

      const rows = coinEvidence('BTCUSDT', { v3 });
      expect(rows[0]?.position).toEqual({ kind: 'cash' });
    });

    it('yields no_bar and null barClose when hypothesis has no latestBar', () => {
      const v4: LabV4Response = {
        version: 'lab-v4',
        threshold: 800,
        hypotheses: [
          makeLabV4Hypothesis({
            id: 'S1-1h',
            latestBar: null,
            openTrades: [],
          }),
        ],
      };
      const v3: LabV3Response = {
        version: 'lab-v3',
        threshold: 200,
        hypotheses: [
          makeLabV3Hypothesis({
            id: 'F1-1d',
            latestBar: null,
          }),
        ],
      };
      const v2: LabV2Response = {
        version: 'lab-v2',
        threshold: 200,
        hypotheses: [
          makeLabV2Hypothesis({
            id: 'N2-1d',
            latestBar: null,
          }),
        ],
      };
      const v1: LabResponse = {
        version: 'lab-v1',
        threshold: 800,
        hypotheses: [
          makeLabV1Hypothesis({
            id: 'L1-8h',
            latestBar: null,
          }),
        ],
      };

      const rows = coinEvidence('BTCUSDT', { v1, v2, v3, v4 });

      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.position).toEqual({ kind: 'no_bar' });
        expect(row.barClose).toBeNull();
      }
    });
  });

  describe('sort order', () => {
    it('sorts rows by e / threshold descending', () => {
      const v2: LabV2Response = {
        version: 'lab-v2',
        threshold: 200,
        hypotheses: [
          makeLabV2Hypothesis({
            id: 'N2-first',
            e: 100, // 100 / 200 = 0.5 (rank 1)
            threshold: 200,
          }),
          makeLabV2Hypothesis({
            id: 'N3-third',
            e: 10, // 10 / 200 = 0.05 (rank 3)
            threshold: 200,
          }),
        ],
      };
      const v3: LabV3Response = {
        version: 'lab-v3',
        threshold: 200,
        hypotheses: [
          makeLabV3Hypothesis({
            id: 'F1-second',
            e: 50, // 50 / 200 = 0.25 (rank 2)
            threshold: 200,
          }),
        ],
      };
      const v1: LabResponse = {
        version: 'lab-v1',
        threshold: 800,
        hypotheses: [
          makeLabV1Hypothesis({
            id: 'L1-fourth',
            e: 1.84, // 1.84 / 800 = 0.0023 (rank 4)
            threshold: 800,
          }),
        ],
      };

      const rows = coinEvidence('BTCUSDT', { v1, v2, v3 });

      expect(rows.map((r) => r.id)).toEqual([
        'N2-first',
        'F1-second',
        'N3-third',
        'L1-fourth',
      ]);
    });

    it('counts threshold of 0 as ratio 0 and preserves insertion order on tie-break', () => {
      const v4: LabV4Response = {
        version: 'lab-v4',
        threshold: 800,
        hypotheses: [
          makeLabV4Hypothesis({
            id: 'S1-zero',
            e: 10,
            threshold: 0, // ratio 0
          }),
        ],
      };
      const v2: LabV2Response = {
        version: 'lab-v2',
        threshold: 200,
        hypotheses: [
          makeLabV2Hypothesis({
            id: 'N2-zero',
            e: 0,
            threshold: 200, // ratio 0
          }),
        ],
      };
      const v3: LabV3Response = {
        version: 'lab-v3',
        threshold: 200,
        hypotheses: [
          makeLabV3Hypothesis({
            id: 'F1-active',
            e: 20,
            threshold: 200, // ratio 0.1
          }),
        ],
      };

      const rows = coinEvidence('BTCUSDT', { v4, v3, v2 });

      // F1-active (0.1) comes first.
      // S1-zero (v4) comes before N2-zero (v2) because insertion order is v4, then v3, then v2.
      expect(rows.map((r) => r.id)).toEqual([
        'F1-active',
        'S1-zero',
        'N2-zero',
      ]);
    });
  });

  describe('lab-v1 behavior', () => {
    it('yields flat when coin is present or not present in latestBar.coins', () => {
      const v1: LabResponse = {
        version: 'lab-v1',
        threshold: 800,
        hypotheses: [
          makeLabV1Hypothesis({
            id: 'L1-scored',
            latestBar: {
              barClose: '2026-10-23T08:00:00.000Z',
              late: false,
              coins: [{ symbol: 'BTCUSDT', score: 90, rank: 1 }],
              skipped: [],
            },
          }),
          makeLabV1Hypothesis({
            id: 'L2-unscored',
            latestBar: {
              barClose: '2026-10-23T08:00:00.000Z',
              late: false,
              coins: [{ symbol: 'ETHUSDT', score: 90, rank: 1 }],
              skipped: [],
            },
          }),
        ],
      };

      const rows = coinEvidence('BTCUSDT', { v1 });
      expect(rows).toHaveLength(2);
      expect(rows[0]?.position).toEqual({ kind: 'flat' });
      expect(rows[1]?.position).toEqual({ kind: 'flat' });
    });
  });

  describe('empty / omitted labs', () => {
    it('returns empty array when labs object is empty', () => {
      const rows = coinEvidence('BTCUSDT', {});
      expect(rows).toEqual([]);
    });

    it('retains not_shown hypotheses matching component behavior', () => {
      const v3: LabV3Response = {
        version: 'lab-v3',
        threshold: 200,
        hypotheses: [
          makeLabV3Hypothesis({
            id: 'F1-1d',
            status: 'not_shown',
          }),
        ],
      };

      const rows = coinEvidence('BTCUSDT', { v3 });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('not_shown');
    });
  });
});
