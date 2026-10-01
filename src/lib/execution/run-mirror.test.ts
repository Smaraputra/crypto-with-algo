// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  BinanceDemoClient,
  WritesDisabledError,
  type DemoAlgoOrder,
  type DemoPosition,
  type DemoVenueFilter,
} from './binance-demo';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();
  await mongoose.connect(mongoServer.getUri());
}, 60_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  await mongoose.connection.db?.dropDatabase();
  vi.restoreAllMocks();
});

async function modules() {
  const m = await import('./run-mirror');
  const { PaperLedger } = await import('@/lib/models/paper-ledger');
  const { Candle } = await import('@/lib/models/candle');
  return { ...m, PaperLedger, Candle };
}

const FILTER: DemoVenueFilter = {
  symbol: 'BTCUSDT',
  status: 'TRADING',
  stepSize: 0.0001,
  minQty: 0.0001,
  minNotional: 50,
  tickSize: 0.1,
};

/**
 * A client stand-in. It is a real `BinanceDemoClient` subclass so the write
 * guard is the real one, with only the network replaced.
 */
class FakeClient extends BinanceDemoClient {
  calls: string[] = [];
  constructor(
    private readonly state: {
      canTrade?: boolean;
      oneWay?: boolean;
      balance?: number;
      filters?: DemoVenueFilter[];
      positions?: DemoPosition[];
      algos?: DemoAlgoOrder[];
      failOn?: string;
    },
    writesEnabled: boolean
  ) {
    super({
      apiKey: 'k'.repeat(20),
      apiSecret: 's'.repeat(20),
      writesEnabled,
      fetchImpl: (async () => {
        throw new Error('the fake client must not reach the network');
      }) as unknown as typeof fetch,
    });
  }
  async permissions() {
    return { canTrade: this.state.canTrade ?? true, feeTier: 0, multiAssetsMargin: false };
  }
  async isOneWayMode() {
    return this.state.oneWay ?? true;
  }
  async usdtBalance() {
    return this.state.balance ?? 5000;
  }
  async venueFilters() {
    return new Map((this.state.filters ?? [FILTER]).map((f) => [f.symbol, f]));
  }
  async openPositions() {
    return this.state.positions ?? [];
  }
  async openAlgoOrders() {
    return this.state.algos ?? [];
  }
  private record(name: string) {
    if (!this.writesEnabled) throw new WritesDisabledError(name);
    this.calls.push(name);
    if (this.state.failOn === name) throw new Error(`venue rejected ${name}`);
  }
  async marketOrder(args: { symbol: string; side: string; quantity: number; reduceOnly?: boolean }) {
    this.record(`market:${args.side}:${args.quantity}${args.reduceOnly ? ':reduceOnly' : ''}`);
    return { orderId: 1, status: 'FILLED' };
  }
  async conditionalOrder(args: { type: string; triggerPrice: number }) {
    this.record(`algo:${args.type}:${args.triggerPrice}`);
    return { algoId: 1 };
  }
  async cancelAlgoOrder(_symbol: string, algoId: number) {
    this.record(`cancel:${algoId}`);
  }
}

async function seedLedger(
  PaperLedger: Awaited<ReturnType<typeof modules>>['PaperLedger'],
  position: Record<string, unknown> | null
) {
  await PaperLedger.create({
    tradingStyle: 'day_trading',
    interval: '15m',
    symbol: 'BTCUSDT',
    equity: 1000,
    executableEquity: 1000,
    trades: 0,
    position,
  });
}

async function seedCandle(Candle: Awaited<ReturnType<typeof modules>>['Candle'], close = 76000) {
  await Candle.create({
    symbol: 'BTCUSDT',
    interval: '15m',
    timestamp: Date.UTC(2026, 0, 1),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  });
}

const OPEN_LONG = {
  side: 'long',
  entryPrice: 76000,
  entryRawPrice: 76000,
  entryTime: Date.UTC(2026, 0, 1),
  quantity: 0.01,
  stopPrice: 75000,
  targetPrice: 78000,
  timeStopBars: null,
  entrySlippageCost: 0,
  fundingPnl: 0,
  entryScore: 35,
  entryTier: 'buy',
  entrySession: null,
  entryConfigVersion: 7,
  signalCreatedAt: Date.UTC(2026, 0, 1),
  executableEntryPrice: null,
  executableEntryTime: null,
  fundingCharges: [],
};

describe('executionEnabled', () => {
  it('is true only for the exact string', async () => {
    const { executionEnabled } = await modules();
    expect(executionEnabled('true')).toBe(true);
    for (const raw of ['TRUE', 'True', '1', 'yes', 'on', '', ' true', undefined]) {
      expect(executionEnabled(raw)).toBe(false);
    }
  });
});

describe('mirrorScale', () => {
  it('scales by demo balance against the book nominal', async () => {
    const { mirrorScale } = await modules();
    // 5,000 demo against ten ledgers of 1,000 is half size.
    expect(mirrorScale(5000, 10)).toBeCloseTo(0.5, 10);
    expect(mirrorScale(10000, 10)).toBeCloseTo(1, 10);
  });

  it('is zero for a dead balance or no symbols', async () => {
    const { mirrorScale } = await modules();
    expect(mirrorScale(0, 10)).toBe(0);
    expect(mirrorScale(-5, 10)).toBe(0);
    expect(mirrorScale(5000, 0)).toBe(0);
  });
});

describe('desiredFromLedger', () => {
  it('returns null for a flat or missing ledger', async () => {
    const { desiredFromLedger } = await modules();
    expect(desiredFromLedger(null)).toBeNull();
    expect(desiredFromLedger({ symbol: 'BTCUSDT', position: null } as never)).toBeNull();
  });

  it('carries the side, size, stop and target across', async () => {
    const { desiredFromLedger } = await modules();
    expect(desiredFromLedger({ symbol: 'BTCUSDT', position: OPEN_LONG } as never)).toEqual({
      symbol: 'BTCUSDT',
      side: 'long',
      quantity: 0.01,
      stopPrice: 75000,
      targetPrice: 78000,
    });
  });
});

describe('runMirror: it halts rather than guess', () => {
  it('halts on an unknown book', async () => {
    const { runMirror } = await modules();
    const report = await runMirror({ book: 'day_trading:30m', client: new FakeClient({}, false) });
    expect(report.haltReason).toContain('Unknown paper desk book');
    expect(report.totalIntents).toBe(0);
  });

  it('halts when the credentials are absent', async () => {
    const { runMirror } = await modules();
    delete process.env.BINANCE_DEMO_API_KEY;
    delete process.env.BINANCE_DEMO_API_SECRET;
    const report = await runMirror({ book: 'day_trading:15m' });
    expect(report.haltReason).toContain('BINANCE_DEMO_API_KEY');
    expect(report.haltReason).toContain('/opt/sites/crypto/.env');
  });

  it('halts in Hedge Mode, because every exit uses reduceOnly', async () => {
    const { runMirror } = await modules();
    const report = await runMirror({
      book: 'day_trading:15m',
      client: new FakeClient({ oneWay: false }, false),
    });
    expect(report.oneWay).toBe(false);
    expect(report.haltReason).toContain('Hedge Mode');
    expect(report.totalIntents).toBe(0);
  });

  it('halts when the account cannot trade, or has no balance', async () => {
    const { runMirror } = await modules();
    const cannot = await runMirror({ book: 'day_trading:15m', client: new FakeClient({ canTrade: false }, false) });
    expect(cannot.haltReason).toContain('canTrade false');
    const broke = await runMirror({ book: 'day_trading:15m', client: new FakeClient({ balance: 0 }, false) });
    expect(broke.haltReason).toContain('no USDT balance');
  });
});

describe('runMirror: dry run is the default', () => {
  it('plans the orders and sends nothing', async () => {
    const { runMirror, PaperLedger, Candle } = await modules();
    await seedLedger(PaperLedger, OPEN_LONG);
    await seedCandle(Candle);
    const client = new FakeClient({}, false);

    const lines: string[] = [];
    const report = await runMirror({ book: 'day_trading:15m', client, log: (l) => lines.push(l) });

    expect(report.dryRun).toBe(true);
    expect(report.haltReason).toBeNull();
    // 5,000 demo over ten 1,000 ledgers halves the desk's 0.01 to 0.005.
    expect(report.scale).toBeCloseTo(0.5, 10);
    const btc = report.symbols.find((s) => s.symbol === 'BTCUSDT')!;
    expect(btc.intents[0]).toContain('OPEN BUY 0.005 BTCUSDT');
    expect(btc.intents[1]).toContain('STOP_MARKET SELL 0.005 BTCUSDT @ 75000');
    expect(btc.intents[2]).toContain('TAKE_PROFIT_MARKET SELL 0.005 BTCUSDT @ 78000');
    expect(report.totalSent).toBe(0);
    expect(client.calls).toEqual([]);
    expect(lines.some((l) => l.includes('DRY RUN'))).toBe(true);
    expect(lines.some((l) => l.startsWith('  would:'))).toBe(true);
  });

  it('reports no intents for a symbol both sides agree is flat', async () => {
    const { runMirror, PaperLedger } = await modules();
    await seedLedger(PaperLedger, null);
    const report = await runMirror({ book: 'day_trading:15m', client: new FakeClient({}, false) });
    const btc = report.symbols.find((s) => s.symbol === 'BTCUSDT')!;
    expect(btc.intents).toEqual([]);
    expect(report.totalIntents).toBe(0);
  });

  it('skips a symbol the demo venue does not list or has halted', async () => {
    const { runMirror, PaperLedger, Candle } = await modules();
    await seedLedger(PaperLedger, OPEN_LONG);
    await seedCandle(Candle);

    const missing = await runMirror({
      book: 'day_trading:15m',
      client: new FakeClient({ filters: [] }, false),
    });
    expect(missing.symbols.find((s) => s.symbol === 'BTCUSDT')!.skipped).toContain('does not list');

    const halted = await runMirror({
      book: 'day_trading:15m',
      client: new FakeClient({ filters: [{ ...FILTER, status: 'BREAK' }] }, false),
    });
    expect(halted.symbols.find((s) => s.symbol === 'BTCUSDT')!.skipped).toContain('BREAK');
  });

  it('reports a venue position in a symbol outside the signal set', async () => {
    const { runMirror, PaperLedger } = await modules();
    await seedLedger(PaperLedger, null);
    const report = await runMirror({
      book: 'day_trading:15m',
      client: new FakeClient(
        { positions: [{ symbol: 'PEPEUSDT', positionAmt: 100, entryPrice: 1, unrealizedProfit: 0 }] },
        false
      ),
    });
    expect(report.strayPositions).toEqual(['PEPEUSDT amt=100']);
  });

  it('skips the minimum-notional check when no candle is available', async () => {
    const { runMirror, PaperLedger } = await modules();
    await seedLedger(PaperLedger, OPEN_LONG);
    const report = await runMirror({ book: 'day_trading:15m', client: new FakeClient({}, false) });
    expect(report.symbols.find((s) => s.symbol === 'BTCUSDT')!.skipped).toContain('no candle');
  });
});

describe('runMirror: executing', () => {
  it('sends the planned orders when explicitly enabled', async () => {
    const { runMirror, PaperLedger, Candle } = await modules();
    await seedLedger(PaperLedger, OPEN_LONG);
    await seedCandle(Candle);
    const client = new FakeClient({}, true);

    const report = await runMirror({ book: 'day_trading:15m', client, execute: true });

    expect(report.dryRun).toBe(false);
    expect(client.calls).toEqual([
      'market:BUY:0.005',
      'algo:STOP_MARKET:75000',
      'algo:TAKE_PROFIT_MARKET:78000',
    ]);
    expect(report.totalSent).toBe(3);
    expect(report.totalFailed).toBe(0);
  });

  it('closes a venue position the desk has exited, cancelling protection first', async () => {
    const { runMirror, PaperLedger } = await modules();
    await seedLedger(PaperLedger, null);
    const client = new FakeClient(
      {
        positions: [{ symbol: 'BTCUSDT', positionAmt: 0.005, entryPrice: 76000, unrealizedProfit: 0 }],
        algos: [
          {
            algoId: 42,
            clientAlgoId: 'day_trading:15m-BTCUSDT-stop',
            symbol: 'BTCUSDT',
            side: 'SELL',
            type: 'STOP_MARKET',
            triggerPrice: 75000,
            quantity: 0.005,
          },
        ],
      },
      true
    );

    const report = await runMirror({ book: 'day_trading:15m', client, execute: true });
    expect(client.calls).toEqual(['cancel:42', 'market:SELL:0.005:reduceOnly']);
    expect(report.totalFailed).toBe(0);
  });

  it('stops at the first failure on a symbol, so a stop is never sized to a position that did not open', async () => {
    const { runMirror, PaperLedger, Candle } = await modules();
    await seedLedger(PaperLedger, OPEN_LONG);
    await seedCandle(Candle);
    const client = new FakeClient({ failOn: 'market:BUY:0.005' }, true);

    const report = await runMirror({ book: 'day_trading:15m', client, execute: true });

    expect(client.calls).toEqual(['market:BUY:0.005']);
    expect(report.totalSent).toBe(0);
    expect(report.totalFailed).toBe(1);
    const btc = report.symbols.find((s) => s.symbol === 'BTCUSDT')!;
    expect(btc.errors[0]).toContain('venue rejected');
    // The intents were all planned; only the sending stopped.
    expect(btc.intents).toHaveLength(3);
  });

  it('cannot send anything when the client itself has writes disabled', async () => {
    const { runMirror, PaperLedger, Candle } = await modules();
    await seedLedger(PaperLedger, OPEN_LONG);
    await seedCandle(Candle);
    // execute: true, but the client refuses: the second, independent guard.
    const client = new FakeClient({}, false);
    const report = await runMirror({ book: 'day_trading:15m', client, execute: true });
    expect(client.calls).toEqual([]);
    expect(report.totalFailed).toBe(1);
    expect(report.symbols.find((s) => s.symbol === 'BTCUSDT')!.errors[0]).toContain('Writes are disabled');
  });
});

describe('summariseMirror', () => {
  it('leads with the halt reason when there is one', async () => {
    const { summariseMirror } = await modules();
    expect(
      summariseMirror({
        book: 'day_trading:15m',
        dryRun: true,
        haltReason: 'Hedge Mode',
        balance: null,
        scale: null,
        oneWay: false,
        canTrade: null,
        symbols: [],
        totalIntents: 0,
        totalSent: 0,
        totalFailed: 0,
        strayPositions: [],
      })
    ).toBe('mirror day_trading:15m HALTED: Hedge Mode');
  });

  it('says nothing was sent on a dry run, and counts sends on a live one', async () => {
    const { summariseMirror } = await modules();
    const base = {
      book: 'day_trading:15m',
      haltReason: null,
      balance: 5000,
      scale: 0.5,
      oneWay: true,
      canTrade: true,
      symbols: [],
      totalIntents: 3,
      totalSent: 0,
      totalFailed: 0,
      strayPositions: [],
    };
    expect(summariseMirror({ ...base, dryRun: true })).toContain('none sent');
    expect(summariseMirror({ ...base, dryRun: false, totalSent: 3 })).toContain('3 sent, 0 failed');
    expect(summariseMirror({ ...base, dryRun: true, strayPositions: ['PEPEUSDT amt=1'] })).toContain('stray:');
  });
});
