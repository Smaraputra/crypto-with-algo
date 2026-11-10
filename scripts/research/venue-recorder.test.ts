// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildRows,
  coinKey,
  parseArgs,
  parseAsterPremium,
  parseAsterSymbols,
  parseBinanceFundingInfo,
  parseBinancePremium,
  parseBybitTickers,
  parseDepth,
  parseHyperliquidBook,
  parseHyperliquidCtxs,
  parseLighterDetails,
  parseLighterFunding,
  parseLighterMarkets,
  parseLighterOrders,
  recordedCoins,
  slipBps,
  writeSnapshot,
  type Manifest,
  type SnapshotRow,
  type Venue,
  type VenueCoinData,
} from './venue-recorder';

// ---------------------------------------------------------------------------
// Real sample fixtures (small literals copied from .superpowers/sdd/venue-frontier/samples/)
// ---------------------------------------------------------------------------

const binancePremiumSample = {
  symbol: 'BTCUSDT',
  markPrice: '72927.50000000',
  indexPrice: '72960.75021739',
  estimatedSettlePrice: '73299.73635027',
  lastFundingRate: '0.00006049',
  interestRate: '0.00010000',
  nextFundingTime: 1794355200000,
  time: 1794328536001,
};

const binanceFundingInfoSample = [
  { symbol: 'GTCUSDT', fundingIntervalHours: 4 },
  { symbol: 'LPTUSDT', fundingIntervalHours: 4 },
  { symbol: 'TRBUSDT', fundingIntervalHours: 4 },
];

const binanceDepthSample = {
  lastUpdateId: 12070574268788,
  bids: [
    ['72849.90', '17.639'],
    ['72849.80', '0.469'],
  ],
  asks: [
    ['72850.00', '17.479'],
    ['72850.10', '0.005'],
  ],
};

const bybitTickersSample = {
  retCode: 0,
  retMsg: 'OK',
  result: {
    category: 'linear',
    list: [
      {
        symbol: 'BTCUSDT',
        lastPrice: '72896.70',
        indexPrice: '72924.85',
        markPrice: '72895.26',
        openInterest: '70098.456',
        openInterestValue: '5109845175.72',
        fundingRate: '0.00009296',
        nextFundingTime: '1794355200000',
        fundingIntervalHour: '8',
      },
      {
        symbol: 'BTCUSDC',
        markPrice: '72895.26',
      },
    ],
  },
};

const bybitOrderbookSample = {
  retCode: 0,
  retMsg: 'OK',
  result: {
    s: 'BTCUSDT',
    a: [
      ['72901.10', '10.789'],
      ['72901.20', '0.001'],
    ],
    b: [
      ['72901.00', '1.082'],
      ['72900.90', '0.001'],
    ],
  },
};

const hlMetaAndCtxsSample = [
  {
    universe: [
      { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
      { name: 'ETH', szDecimals: 4, maxLeverage: 25 },
      { name: 'DELISTED', isDelisted: true, maxLeverage: 5 },
    ],
  },
  [
    {
      funding: '0.0000125',
      openInterest: '42467.2305',
      oraclePx: '73027.0',
      markPx: '72997.0',
    },
    {
      funding: '0.0000069737',
      openInterest: '796115.1402000001',
      oraclePx: '2016.7',
      markPx: '2015.8',
    },
    {
      funding: '0.0',
      openInterest: '100',
      oraclePx: '1.0',
      markPx: '1.0',
    },
  ],
];

const hlL2BookSample = {
  coin: 'ARB',
  time: 1794328509517,
  levels: [
    [
      { px: '0.15755', sz: '17578.2', n: 1 },
      { px: '0.15754', sz: '9838.6', n: 2 },
    ],
    [
      { px: '0.15762', sz: '4293.1', n: 1 },
      { px: '0.15765', sz: '55769.0', n: 1 },
    ],
  ],
};

const lighterOrderBooksSample = {
  code: 200,
  order_books: [
    { symbol: 'AI16Z', market_id: 22, market_type: 'perp', status: 'inactive' },
    { symbol: 'NOW', market_id: 191, market_type: 'perp', status: 'active' },
    { symbol: 'APEX', market_id: 86, market_type: 'perp', status: 'active' },
    { symbol: 'SPOT_PAIR', market_id: 99, market_type: 'spot', status: 'active' },
  ],
};

const lighterDetailsSample = {
  code: 200,
  order_book_details: [
    {
      symbol: 'BTC',
      market_id: 1,
      mark_price: '73025.1',
      index_price: '73026.6',
      open_interest_usd: '309677687.620200',
    },
  ],
};

const lighterFundingsSample = {
  code: 200,
  resolution: '1h',
  fundings: [
    { timestamp: 1791604800, rate: '0.0004' },
    { timestamp: 1791608400, rate: '0.0001' },
    { timestamp: 1791612000, rate: '0.0008' },
  ],
};

const lighterOrdersSample = {
  code: 200,
  asks: [
    { price: '73027.7', remaining_base_amount: '0.19606' },
    { price: '73027.8', remaining_base_amount: '0.45539' },
  ],
  bids: [
    { price: '73022.7', remaining_base_amount: '0.15572' },
    { price: '73022.5', remaining_base_amount: '0.32392' },
  ],
};

const asterExchangeInfoSample = {
  symbols: [
    { symbol: 'ASTERUSDT', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'ASTER', quoteAsset: 'USDT' },
    { symbol: 'BTCUSDT', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'BTC', quoteAsset: 'USDT' },
    { symbol: 'ETHUSDT', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'ETH', quoteAsset: 'USDT' },
    { symbol: 'OLDUSDT', status: 'SETTLING', contractType: 'PERPETUAL', baseAsset: 'OLD', quoteAsset: 'USDT' },
    { symbol: 'BTCEUR', status: 'TRADING', contractType: 'PERPETUAL', baseAsset: 'BTC', quoteAsset: 'EUR' },
  ],
};

const asterPremiumSample = {
  symbol: 'BTCUSDT',
  markPrice: '73000',
  indexPrice: '73026.84021739',
  estimatedSettlePrice: '73288.76949644',
  lastFundingRate: '0.00010000',
  interestRate: '0.00010000',
  nextFundingTime: 1794355200000,
  time: 1794328511000,
};

const asterDepthSample = {
  lastUpdateId: 646735341435,
  bids: [
    ['72981.6', '0.001'],
    ['72979.0', '0.164'],
  ],
  asks: [
    ['72982.0', '0.018'],
    ['72984.0', '1.300'],
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('1. Parsers on samples', () => {
  it('parses Binance premium index and funding info', () => {
    const premiums = parseBinancePremium(binancePremiumSample);
    const btc = premiums.get('BTCUSDT')!;
    expect(btc).toBeDefined();
    expect(btc.mark).toBe(72927.5);
    expect(btc.index).toBeCloseTo(72960.75021739, 8);
    expect(btc.fundingRate).toBe(0.00006049);
    expect(btc.nextFundingTime).toBe(1794355200000);

    const fundingInfo = parseBinanceFundingInfo(binanceFundingInfoSample);
    expect(fundingInfo.get('GTCUSDT')).toBe(4);
    expect(fundingInfo.get('BTCUSDT')).toBeUndefined();
  });

  it('parses Bybit tickers', () => {
    const tickers = parseBybitTickers(bybitTickersSample);
    const btc = tickers.get('BTCUSDT')!;
    expect(btc).toBeDefined();
    expect(btc.mark).toBe(72895.26);
    expect(btc.index).toBe(72924.85);
    expect(btc.fundingRate).toBe(0.00009296);
    expect(btc.nextFundingTime).toBe(1794355200000);
    expect(btc.fundingIntervalHours).toBe(8);
    expect(btc.oiUsd).toBe(5109845175.72);
    expect(tickers.get('BTCUSDC')).toBeUndefined();
  });

  it('parses Hyperliquid ctxs and skips delisted', () => {
    const ctxs = parseHyperliquidCtxs(hlMetaAndCtxsSample);
    const btc = ctxs.get('BTC')!;
    expect(btc).toBeDefined();
    expect(btc.fundingRate).toBe(0.0000125);
    expect(btc.fundingIntervalHours).toBe(1);
    expect(btc.mark).toBe(72997.0);
    expect(btc.index).toBe(73027.0);
    expect(btc.oiUsd).toBeCloseTo(42467.2305 * 72997.0, 4);
    expect(ctxs.get('DELISTED')).toBeUndefined();
  });

  it('parses Hyperliquid book', () => {
    const book = parseHyperliquidBook(hlL2BookSample);
    expect(book.bids).toEqual([
      [0.15755, 17578.2],
      [0.15754, 9838.6],
    ]);
    expect(book.asks).toEqual([
      [0.15762, 4293.1],
      [0.15765, 55769.0],
    ]);
  });

  it('parses Lighter markets filtering for active perps', () => {
    const markets = parseLighterMarkets(lighterOrderBooksSample);
    expect(markets.map((m) => m.symbol)).toEqual(['NOW', 'APEX']);
    expect(markets.find((m) => m.symbol === 'NOW')?.marketId).toBe(191);
    expect(markets.find((m) => m.symbol === 'AI16Z')).toBeUndefined();
    expect(markets.find((m) => m.symbol === 'SPOT_PAIR')).toBeUndefined();
  });

  it('parses Lighter details', () => {
    const details = parseLighterDetails(lighterDetailsSample);
    expect(details.mark).toBe(73025.1);
    expect(details.index).toBe(73026.6);
    expect(details.oiUsd).toBe(309677687.6202);
  });

  it('parses Lighter funding selecting latest row', () => {
    const funding = parseLighterFunding(lighterFundingsSample);
    expect(funding.fundingRate).toBe(0.0008);
    expect(funding.fundingIntervalHours).toBe(1);
  });

  it('parses Lighter orders', () => {
    const orders = parseLighterOrders(lighterOrdersSample);
    expect(orders.asks).toEqual([
      [73027.7, 0.19606],
      [73027.8, 0.45539],
    ]);
    expect(orders.bids).toEqual([
      [73022.7, 0.15572],
      [73022.5, 0.32392],
    ]);
  });

  it('parses Aster symbols and premium', () => {
    const symbols = parseAsterSymbols(asterExchangeInfoSample);
    expect(symbols).toEqual(['ASTERUSDT', 'BTCUSDT', 'ETHUSDT']);

    const premiums = parseAsterPremium(asterPremiumSample);
    const btc = premiums.get('BTCUSDT')!;
    expect(btc).toBeDefined();
    expect(btc.mark).toBe(73000);
    expect(btc.index).toBeCloseTo(73026.84021739, 8);
    expect(btc.fundingRate).toBe(0.0001);
    expect(btc.nextFundingTime).toBe(1794355200000);
  });

  it('parses generic depth for Binance, Bybit, and Aster', () => {
    const bDepth = parseDepth(binanceDepthSample);
    expect(bDepth.bids[0]).toEqual([72849.9, 17.639]);
    expect(bDepth.asks[0]).toEqual([72850.0, 17.479]);

    const bybitDepth = parseDepth(bybitOrderbookSample);
    expect(bybitDepth.bids[0]).toEqual([72901.0, 1.082]);
    expect(bybitDepth.asks[0]).toEqual([72901.1, 10.789]);

    const aDepth = parseDepth(asterDepthSample);
    expect(aDepth.bids[0]).toEqual([72981.6, 0.001]);
    expect(aDepth.asks[0]).toEqual([72982.0, 0.018]);
  });
});

describe('2. coinKey', () => {
  it('normalises coin symbols across venues according to the rules', () => {
    expect(coinKey('binance', '1000PEPEUSDT')).toBe('PEPE');
    expect(coinKey('hyperliquid', 'kPEPE')).toBe('PEPE');
    expect(coinKey('hyperliquid', 'BTC')).toBe('BTC');
    expect(coinKey('lighter', '1000SHIB')).toBe('SHIB');
    expect(coinKey('binance', '1INCHUSDT')).toBe('1INCH');
    expect(coinKey('bybit', '1000000MOGUSDT')).toBe('MOG');
  });
});

describe('3. slipBps', () => {
  const asks: [number, number][] = [
    [100, 5],
    [101, 10],
  ];
  const bids: [number, number][] = [
    [99, 5],
    [98, 10],
  ];
  const mid = 99.5;

  it('calculates buy slip accurately matching hand computation', () => {
    const buySlip = slipBps(asks, 'buy', 1000, mid);
    const expectedAvg = 1000 / (5 + 500 / 101);
    const expectedSlip = (expectedAvg / mid - 1) * 1e4;
    expect(buySlip).not.toBeNull();
    expect(buySlip!).toBeCloseTo(expectedSlip, 9);
    expect(buySlip!).toBeCloseTo(100.252506313, 6);
  });

  it('calculates sell slip accurately matching hand computation', () => {
    const sellSlip = slipBps(bids, 'sell', 1000, mid);
    const expectedAvg = 1000 / (5 + 505 / 98);
    const expectedSlip = (1 - expectedAvg / mid) * 1e4;
    expect(sellSlip).not.toBeNull();
    expect(sellSlip!).toBeCloseTo(expectedSlip, 9);
    expect(sellSlip!).toBeCloseTo(101.26006919, 6);
  });

  it('returns null if book holds insufficient depth', () => {
    const thinAsks: [number, number][] = [[100, 6]]; // 600 USD total
    expect(slipBps(thinAsks, 'buy', 1000, 100)).toBeNull();
    const thinBids: [number, number][] = [[99, 6]];
    expect(slipBps(thinBids, 'sell', 1000, 99)).toBeNull();
  });

  it('accepts book object with both bids and asks', () => {
    const buy = slipBps({ bids, asks }, 'buy', 1000);
    const sell = slipBps({ bids, asks }, 'sell', 1000);
    expect(buy).toBeCloseTo(100.252506313, 6);
    expect(sell).toBeCloseTo(101.26006919, 6);
  });
});

describe('4. recordedCoins', () => {
  it('returns only coins on at least two venues and sorts them', () => {
    const listings = new Map<Venue, Set<string>>([
      ['binance', new Set(['BTC', 'ETH', 'SOL', 'UNI'])],
      ['bybit', new Set(['BTC', 'ETH', 'DOGE'])],
      ['hyperliquid', new Set(['BTC', 'SOL', 'PEPE'])],
      ['lighter', new Set(['BTC', 'ETH'])],
      ['aster', new Set(['BTC'])],
    ]);
    const recorded = recordedCoins(listings);
    expect(recorded).toEqual(['BTC', 'ETH', 'SOL']);
  });
});

describe('5. Lighter orders sorting', () => {
  it('gives identical slippage for unsorted orders as for sorted orders', () => {
    const sortedAsks: [number, number][] = [
      [100, 5],
      [101, 10],
    ];
    const unsortedAsks: [number, number][] = [
      [101, 10],
      [100, 5],
    ];
    const sortedBids: [number, number][] = [
      [99, 5],
      [98, 10],
    ];
    const unsortedBids: [number, number][] = [
      [98, 10],
      [99, 5],
    ];

    const buySorted = slipBps(sortedAsks, 'buy', 1000, 99.5);
    const buyUnsorted = slipBps(unsortedAsks, 'buy', 1000, 99.5);
    expect(buyUnsorted).toBe(buySorted);

    const sellSorted = slipBps(sortedBids, 'sell', 1000, 99.5);
    const sellUnsorted = slipBps(unsortedBids, 'sell', 1000, 99.5);
    expect(sellUnsorted).toBe(sellSorted);
  });
});

describe('6. buildRows', () => {
  const ts = 1794355200000;

  it('gives null for missing fields and preserves other coins on partial failure', () => {
    const venueData: VenueCoinData[] = [
      {
        venue: 'binance',
        coin: 'BTC',
        symbol: 'BTCUSDT',
        fundingRate: 0.0001,
        fundingIntervalHours: 8,
        nextFundingTime: ts + 28800000,
        mark: 73000,
        index: null, // missing index price
        oiUsd: 1000000,
        bids: [[72990, 5]],
        asks: [[73010, 5]],
      },
      {
        venue: 'bybit',
        coin: 'ETH',
        symbol: 'ETHUSDT',
        fundingRate: 0.00005,
        fundingIntervalHours: 8,
        nextFundingTime: ts + 28800000,
        mark: 2500,
        index: 2500.5,
        oiUsd: 500000,
        bids: [[2499, 10]],
        asks: [[2501, 10]],
      },
    ];

    const rows = buildRows(ts, venueData);
    expect(rows).toHaveLength(2);

    const btc = rows.find((r) => r.coin === 'BTC')!;
    expect(btc.index).toBeNull();
    expect(btc.mark).toBe(73000);
    expect(btc.fundingRate).toBe(0.0001);
    expect(btc.spreadBps).toBeCloseTo(((73010 - 72990) / 73000) * 1e4, 4);

    const eth = rows.find((r) => r.coin === 'ETH')!;
    expect(eth.index).toBe(2500.5);
    expect(eth.mark).toBe(2500);
    expect(eth.oiUsd).toBe(500000);
  });
});

describe('7. File writing and dry-run', () => {
  it('appends snapshots on the same UTC day and leaves folder mode 0o700', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'venue-recorder-test-'));
    try {
      const ts = Date.UTC(2026, 10, 11, 12, 0, 0); // 2026-11-11
      const manifest: Manifest = {
        manifest: true,
        ts,
        venues: ['binance', 'bybit'],
        coins: ['BTC'],
        counts: { binance: 1, bybit: 1 },
        errors: [],
        durationMs: 120,
      };
      const rows: SnapshotRow[] = [
        {
          ts,
          venue: 'binance',
          coin: 'BTC',
          symbol: 'BTCUSDT',
          fundingRate: 0.0001,
          fundingIntervalHours: 8,
          nextFundingTime: ts + 28800000,
          mark: 73000,
          index: 73000,
          oiUsd: 1000000,
          bid: 72990,
          ask: 73010,
          spreadBps: 2.74,
          buySlipBps: 1.5,
          sellSlipBps: 1.5,
        },
      ];

      // Run 1
      const file1 = writeSnapshot(tempDir, manifest, rows);
      expect(existsSync(file1)).toBe(true);

      const stats = statSync(join(tempDir, 'venue-snapshots'));
      // Check permissions: 0o700 (owner rwx)
      expect(stats.mode & 0o777).toBe(0o700);

      const lines1 = readFileSync(file1, 'utf8').trim().split('\n');
      expect(lines1).toHaveLength(2); // 1 manifest + 1 row
      expect(JSON.parse(lines1[0]).manifest).toBe(true);

      // Run 2: same UTC day
      const file2 = writeSnapshot(tempDir, manifest, rows);
      expect(file2).toBe(file1);

      const lines2 = readFileSync(file2, 'utf8').trim().split('\n');
      expect(lines2).toHaveLength(4); // Line count doubles
      expect(JSON.parse(lines2[2]).manifest).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('dry-run flag is parsed properly and writes nothing', () => {
    const parsed = parseArgs(['--out', '/tmp/venue-out', '--dry-run', '--coins', 'BTC,ETH']);
    expect(parsed.out).toBe('/tmp/venue-out');
    expect(parsed.dryRun).toBe(true);
    expect(parsed.coins).toEqual(['BTC', 'ETH']);
    expect(parsed.venues).toEqual(['binance', 'bybit', 'hyperliquid', 'lighter', 'aster']);
  });

  it('throws when --out is omitted', () => {
    expect(() => parseArgs(['--dry-run'])).toThrow(/--out is required/);
  });
});
