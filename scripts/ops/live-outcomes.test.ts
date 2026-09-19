// @vitest-environment node
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await mongoose.connection.db?.dropDatabase();
});

async function importModules() {
  const {
    parseArgs,
    runLiveOutcomes,
    defaultCostPercent,
    formatReport,
  } = await import('./live-outcomes');
  const { SignalOutcome } = await import('@/lib/models/signal-outcome');
  return { parseArgs, runLiveOutcomes, defaultCostPercent, formatReport, SignalOutcome };
}

function makeOutcome(overrides: Record<string, unknown> = {}) {
  return {
    signalId: new mongoose.Types.ObjectId(),
    symbol: 'BTCUSDT',
    interval: '1h',
    tradingStyle: 'day_trading',
    tier: 'buy',
    score: 40,
    configVersion: 3,
    candleTimestamp: 1_700_000_000_000,
    horizonBars: 24,
    resolveAt: 1_700_000_000_000 + 25 * 60 * 60 * 1000,
    status: 'resolved',
    entryPrice: 100,
    resolvedAt: new Date('2026-01-10T00:00:00.000Z'),
    ...overrides,
  };
}

describe('defaultCostPercent', () => {
  it('computes two taker legs plus two slippage legs at the style primary interval', async () => {
    const { defaultCostPercent } = await importModules();

    expect(defaultCostPercent('scalping')).toBeCloseTo(0.2, 6); // 5m
    expect(defaultCostPercent('day_trading')).toBeCloseTo(0.16, 6); // 1h
    expect(defaultCostPercent('swing_trading')).toBeCloseTo(0.14, 6); // 4h
    expect(defaultCostPercent('position_trading')).toBeCloseTo(0.14, 6); // 1d
  });
});

describe('parseArgs', () => {
  it('defaults style to all and every other flag to its empty value', async () => {
    const { parseArgs } = await importModules();

    const args = parseArgs([]);

    expect(args).toEqual({
      style: 'all',
      symbol: null,
      since: null,
      cost: null,
      json: false,
      mongoUri: null,
    });
  });

  it('parses every flag', async () => {
    const { parseArgs } = await importModules();

    const args = parseArgs([
      '--style', 'day_trading',
      '--symbol', 'BTCUSDT',
      '--since', '2026-06-01T00:00:00.000Z',
      '--cost', '0.25',
      '--json',
      '--mongo-uri', 'mongodb://localhost:27017/cryptowithalgo',
    ]);

    expect(args.style).toBe('day_trading');
    expect(args.symbol).toBe('BTCUSDT');
    expect(args.since).toEqual(new Date('2026-06-01T00:00:00.000Z'));
    expect(args.cost).toBe(0.25);
    expect(args.json).toBe(true);
    expect(args.mongoUri).toBe('mongodb://localhost:27017/cryptowithalgo');
  });

  it('accepts --cost 0 explicitly, distinct from the unset default', async () => {
    const { parseArgs } = await importModules();

    const args = parseArgs(['--cost', '0']);

    expect(args.cost).toBe(0);
  });

  it('rejects an unrecognized flag', async () => {
    const { parseArgs } = await importModules();

    expect(() => parseArgs(['--bogus'])).toThrow(/unknown flag/i);
  });

  it('rejects an invalid --since date', async () => {
    const { parseArgs } = await importModules();

    expect(() => parseArgs(['--since', 'not-a-date'])).toThrow(/--since/i);
  });

  it('rejects an invalid --style value', async () => {
    const { parseArgs } = await importModules();

    expect(() => parseArgs(['--style', 'bogus_style'])).toThrow(/--style/i);
  });

  it('rejects a non-numeric --cost', async () => {
    const { parseArgs } = await importModules();

    expect(() => parseArgs(['--cost', 'abc'])).toThrow(/--cost/i);
  });

  it('rejects a value-taking flag with no value', async () => {
    const { parseArgs } = await importModules();

    expect(() => parseArgs(['--style'])).toThrow(/--style requires a value/);
  });
});

describe('runLiveOutcomes', () => {
  it('computes gross/net expectancy, status counts, and resolved range for a single style', async () => {
    const { runLiveOutcomes, SignalOutcome } = await importModules();

    // buy tier: directional = forwardReturnPercent as-is
    await SignalOutcome.create(makeOutcome({
      tier: 'buy', forwardReturnPercent: 4, mfePercent: 6, maePercent: -2,
      resolvedAt: new Date('2026-01-10T00:00:00.000Z'),
    }));
    await SignalOutcome.create(makeOutcome({
      tier: 'buy', forwardReturnPercent: -2, mfePercent: 3, maePercent: -5,
      resolvedAt: new Date('2026-01-20T00:00:00.000Z'),
    }));

    // sell tier: directional = -forwardReturnPercent
    await SignalOutcome.create(makeOutcome({
      tier: 'sell', forwardReturnPercent: -3, mfePercent: 1, maePercent: -6,
      resolvedAt: new Date('2026-02-01T00:00:00.000Z'),
    }));
    await SignalOutcome.create(makeOutcome({
      tier: 'sell', forwardReturnPercent: 2, mfePercent: 5, maePercent: -1,
      resolvedAt: new Date('2026-02-10T00:00:00.000Z'),
    }));

    // neutral tier: informational, raw forward return
    await SignalOutcome.create(makeOutcome({
      tier: 'neutral', forwardReturnPercent: -1.5, mfePercent: 2, maePercent: -2,
      resolvedAt: new Date('2026-01-15T00:00:00.000Z'),
    }));

    // pending and unresolvable must count toward statusCounts but not tiers
    await SignalOutcome.create(makeOutcome({
      tier: 'buy', status: 'pending', forwardReturnPercent: null,
      mfePercent: null, maePercent: null, entryPrice: null, resolvedAt: null,
    }));
    await SignalOutcome.create(makeOutcome({
      tier: 'buy', status: 'unresolvable', forwardReturnPercent: null,
      mfePercent: null, maePercent: null, entryPrice: null, resolvedAt: null,
    }));

    const report = await runLiveOutcomes({
      style: 'day_trading', symbol: null, since: null, cost: null,
    });

    expect(report.styles).toHaveLength(1);
    const style = report.styles[0];

    expect(style.style).toBe('day_trading');
    expect(style.interval).toBe('1h');
    expect(style.horizonBars).toBe(24);
    expect(style.costPercent).toBeCloseTo(0.16, 6); // default day_trading (1h) cost
    expect(style.statusCounts).toEqual({ pending: 1, resolved: 5, unresolvable: 1 });
    expect(style.resolvedRange).toEqual({
      from: '2026-01-10T00:00:00.000Z',
      to: '2026-02-10T00:00:00.000Z',
    });

    expect(style.tiers.map((t) => t.tier)).toEqual(['buy', 'neutral', 'sell']);

    const buy = style.tiers.find((t) => t.tier === 'buy')!;
    expect(buy.count).toBe(2);
    expect(buy.grossExpectancyPercent).toBeCloseTo(1, 6); // mean(4, -2)
    expect(buy.netExpectancyPercent).toBeCloseTo(1 - 0.16, 6);
    expect(buy.winRate).toBeCloseTo(0.5, 6);
    expect(buy.avgMfePercent).toBeCloseTo(4.5, 6);
    expect(buy.avgMaePercent).toBeCloseTo(-3.5, 6);

    const neutral = style.tiers.find((t) => t.tier === 'neutral')!;
    expect(neutral.count).toBe(1);
    expect(neutral.grossExpectancyPercent).toBeCloseTo(-1.5, 6);
    expect(neutral.netExpectancyPercent).toBeCloseTo(-1.5 - 0.16, 6);
    expect(neutral.winRate).toBeCloseTo(0, 6);

    const sell = style.tiers.find((t) => t.tier === 'sell')!;
    expect(sell.count).toBe(2);
    expect(sell.grossExpectancyPercent).toBeCloseTo(0.5, 6); // mean(3, -2) directional
    expect(sell.netExpectancyPercent).toBeCloseTo(0.5 - 0.16, 6);
    expect(sell.winRate).toBeCloseTo(0.5, 6);
    expect(sell.avgMfePercent).toBeCloseTo(3, 6); // never flipped
    expect(sell.avgMaePercent).toBeCloseTo(-3.5, 6);
  });

  it('applies --cost 0 so net equals gross', async () => {
    const { runLiveOutcomes, SignalOutcome } = await importModules();

    await SignalOutcome.create(makeOutcome({ tier: 'buy', forwardReturnPercent: 5 }));

    const report = await runLiveOutcomes({
      style: 'day_trading', symbol: null, since: null, cost: 0,
    });

    const [style] = report.styles;
    expect(style.costPercent).toBe(0);
    const buy = style.tiers.find((t) => t.tier === 'buy')!;
    expect(buy.grossExpectancyPercent).toBeCloseTo(5, 6);
    expect(buy.netExpectancyPercent).toBeCloseTo(5, 6);
  });

  it('applies an explicit --cost override instead of the per-style default', async () => {
    const { runLiveOutcomes, SignalOutcome } = await importModules();

    await SignalOutcome.create(makeOutcome({ tier: 'buy', forwardReturnPercent: 5 }));

    const report = await runLiveOutcomes({
      style: 'day_trading', symbol: null, since: null, cost: 1,
    });

    const [style] = report.styles;
    expect(style.costPercent).toBe(1);
    const buy = style.tiers.find((t) => t.tier === 'buy')!;
    expect(buy.netExpectancyPercent).toBeCloseTo(4, 6);
  });

  it('reports zeroed status counts and an empty tier list with no data', async () => {
    const { runLiveOutcomes } = await importModules();

    const report = await runLiveOutcomes({
      style: 'day_trading', symbol: null, since: null, cost: null,
    });

    const [style] = report.styles;
    expect(style.statusCounts).toEqual({ pending: 0, resolved: 0, unresolvable: 0 });
    expect(style.resolvedRange).toEqual({ from: null, to: null });
    expect(style.tiers).toEqual([]);
  });

  it('filters every section by symbol when given', async () => {
    const { runLiveOutcomes, SignalOutcome } = await importModules();

    await SignalOutcome.create(makeOutcome({ symbol: 'BTCUSDT', tier: 'buy', forwardReturnPercent: 5 }));
    await SignalOutcome.create(makeOutcome({ symbol: 'ETHUSDT', tier: 'buy', forwardReturnPercent: -5 }));

    const report = await runLiveOutcomes({
      style: 'day_trading', symbol: 'BTCUSDT', since: null, cost: 0,
    });

    const [style] = report.styles;
    expect(style.statusCounts).toEqual({ pending: 0, resolved: 1, unresolvable: 0 });
    expect(style.tiers).toHaveLength(1);
    expect(style.tiers[0].count).toBe(1);
    expect(style.tiers[0].grossExpectancyPercent).toBeCloseTo(5, 6);
  });

  it('filters only the tier expectancy by since; status counts and resolved range cover all time', async () => {
    const { runLiveOutcomes, SignalOutcome } = await importModules();

    await SignalOutcome.create(makeOutcome({
      tier: 'buy', forwardReturnPercent: 1, resolvedAt: new Date('2026-01-01T00:00:00.000Z'),
    }));
    await SignalOutcome.create(makeOutcome({
      tier: 'buy', forwardReturnPercent: 9, resolvedAt: new Date('2026-09-01T00:00:00.000Z'),
    }));

    const report = await runLiveOutcomes({
      style: 'day_trading', symbol: null, since: new Date('2026-06-01T00:00:00.000Z'), cost: 0,
    });

    const [style] = report.styles;
    // Both resolved outcomes count toward status/coverage regardless of since.
    expect(style.statusCounts).toEqual({ pending: 0, resolved: 2, unresolvable: 0 });
    expect(style.resolvedRange).toEqual({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-09-01T00:00:00.000Z',
    });
    // Only the tier expectancy is narrowed by since.
    expect(style.tiers).toHaveLength(1);
    expect(style.tiers[0].count).toBe(1);
    expect(style.tiers[0].grossExpectancyPercent).toBeCloseTo(9, 6);
  });

  it('orders tiers strong_buy, buy, neutral, sell, strong_sell and omits missing ones', async () => {
    const { runLiveOutcomes, SignalOutcome } = await importModules();

    await SignalOutcome.create(makeOutcome({ tier: 'strong_sell', forwardReturnPercent: 1 }));
    await SignalOutcome.create(makeOutcome({ tier: 'sell', forwardReturnPercent: 1 }));
    await SignalOutcome.create(makeOutcome({ tier: 'strong_buy', forwardReturnPercent: 1 }));
    await SignalOutcome.create(makeOutcome({ tier: 'buy', forwardReturnPercent: 1 }));
    await SignalOutcome.create(makeOutcome({ tier: 'neutral', forwardReturnPercent: 1 }));

    const report = await runLiveOutcomes({
      style: 'day_trading', symbol: null, since: null, cost: null,
    });

    expect(report.styles[0].tiers.map((t) => t.tier)).toEqual([
      'strong_buy', 'buy', 'neutral', 'sell', 'strong_sell',
    ]);
  });

  it('selects all four styles in order when style is all, defaulting cost per style', async () => {
    const { runLiveOutcomes, SignalOutcome } = await importModules();

    await SignalOutcome.create(makeOutcome({
      tradingStyle: 'day_trading', interval: '1h', tier: 'buy', forwardReturnPercent: 2,
    }));
    await SignalOutcome.create(makeOutcome({
      tradingStyle: 'swing_trading', interval: '4h', tier: 'buy', forwardReturnPercent: 3,
    }));

    const report = await runLiveOutcomes({
      style: 'all', symbol: null, since: null, cost: null,
    });

    expect(report.styles.map((s) => s.style)).toEqual([
      'scalping', 'day_trading', 'swing_trading', 'position_trading',
    ]);

    const scalping = report.styles.find((s) => s.style === 'scalping')!;
    expect(scalping.tiers).toEqual([]);
    expect(scalping.costPercent).toBeCloseTo(0.2, 6);

    const dayTrading = report.styles.find((s) => s.style === 'day_trading')!;
    expect(dayTrading.costPercent).toBeCloseTo(0.16, 6);
    expect(dayTrading.tiers[0].grossExpectancyPercent).toBeCloseTo(2, 6);

    const swingTrading = report.styles.find((s) => s.style === 'swing_trading')!;
    expect(swingTrading.costPercent).toBeCloseTo(0.14, 6);
    expect(swingTrading.tiers[0].grossExpectancyPercent).toBeCloseTo(3, 6);

    const positionTrading = report.styles.find((s) => s.style === 'position_trading')!;
    expect(positionTrading.tiers).toEqual([]);
    expect(positionTrading.costPercent).toBeCloseTo(0.14, 6);
  });

  it('selects a single style only, excluding data from every other style', async () => {
    const { runLiveOutcomes, SignalOutcome } = await importModules();

    await SignalOutcome.create(makeOutcome({
      tradingStyle: 'day_trading', interval: '1h', tier: 'buy', forwardReturnPercent: 2,
    }));
    await SignalOutcome.create(makeOutcome({
      tradingStyle: 'swing_trading', interval: '4h', tier: 'buy', forwardReturnPercent: 3,
    }));

    const report = await runLiveOutcomes({
      style: 'day_trading', symbol: null, since: null, cost: null,
    });

    expect(report.styles).toHaveLength(1);
    expect(report.styles[0].style).toBe('day_trading');
  });

  it('sets generatedAt, symbol, and since on the report envelope', async () => {
    const { runLiveOutcomes } = await importModules();

    const since = new Date('2026-06-01T00:00:00.000Z');
    const report = await runLiveOutcomes({
      style: 'day_trading', symbol: 'BTCUSDT', since, cost: null,
    });

    expect(report.symbol).toBe('BTCUSDT');
    expect(report.since).toBe('2026-06-01T00:00:00.000Z');
    expect(() => new Date(report.generatedAt).toISOString()).not.toThrow();
    expect(new Date(report.generatedAt).toISOString()).toBe(report.generatedAt);
  });
});

describe('formatReport', () => {
  const sampleReport = {
    generatedAt: '2026-09-19T00:00:00.000Z',
    symbol: null,
    since: null,
    styles: [
      {
        style: 'day_trading' as const,
        interval: '1h',
        horizonBars: 24,
        costPercent: 0.16,
        statusCounts: { pending: 1, resolved: 2, unresolvable: 0 },
        resolvedRange: { from: '2026-01-10T00:00:00.000Z', to: '2026-02-10T00:00:00.000Z' },
        tiers: [
          {
            tier: 'buy' as const,
            count: 2,
            grossExpectancyPercent: 1,
            netExpectancyPercent: 0.84,
            winRate: 0.5,
            avgMfePercent: 4.5,
            avgMaePercent: -3.5,
          },
        ],
      },
      {
        style: 'swing_trading' as const,
        interval: '4h',
        horizonBars: 30,
        costPercent: 0.14,
        statusCounts: { pending: 0, resolved: 0, unresolvable: 0 },
        resolvedRange: { from: null, to: null },
        tiers: [],
      },
    ],
  };

  it('prints one JSON line per style with --json', async () => {
    const { formatReport } = await importModules();

    const output = formatReport(sampleReport, true);
    const lines = output.split('\n');

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(sampleReport.styles[0]);
    expect(JSON.parse(lines[1])).toEqual(sampleReport.styles[1]);
  });

  it('prints a table with a header per style, a blank line between styles, and the closing note', async () => {
    const { formatReport } = await importModules();

    const output = formatReport(sampleReport, false);

    expect(output).toContain('style=day_trading interval=1h horizon=24 bars');
    expect(output).toContain('cost=0.1600%');
    expect(output).toContain('pending=1 resolved=2 unresolvable=0');
    expect(output).toContain('resolved 2026-01-10T00:00:00.000Z..2026-02-10T00:00:00.000Z');
    expect(output).toContain('style=swing_trading interval=4h horizon=30 bars');
    expect(output).toContain('resolved n/a..n/a');
    expect(output).toMatch(/\n\n/); // blank line between styles
    expect(output.trimEnd().endsWith(
      'note: net subtracts a fixed round-trip cost estimate from a close-to-close forward return; it is not a fill simulation'
    )).toBe(true);
  });
});
