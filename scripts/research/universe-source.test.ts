// @vitest-environment node
import { describe, it, expect } from 'vitest';

import {
  ABSENT_CRYPTO_TICKERS,
  assetKey,
  buildUniverseSource,
  classifyFolder,
  exchangeMapFromJson,
  folderNames,
  keyDates,
  type ExchangeEntry,
  type Lister,
} from './universe-source';

function entry(over: Partial<ExchangeEntry> & { baseAsset: string }): ExchangeEntry {
  return {
    contractType: 'PERPETUAL',
    underlyingType: 'COIN',
    quoteAsset: 'USDT',
    status: 'TRADING',
    onboardDate: 1567965300000,
    deliveryDate: 4133404800000,
    ...over,
  };
}

const EXCHANGE = new Map<string, ExchangeEntry>([
  ['BTCUSDT', entry({ baseAsset: 'BTC' })],
  ['1000SHIBUSDT', entry({ baseAsset: '1000SHIB' })],
  ['LUNA2USDT', entry({ baseAsset: 'LUNA2' })],
  ['LUNCUSDT', entry({ baseAsset: 'LUNC', status: 'SETTLING', deliveryDate: 1700000000000 })],
  ['AAPLUSDT', entry({ baseAsset: 'AAPL', contractType: 'TRADIFI_PERPETUAL', underlyingType: 'EQUITY' })],
  ['XAUUSDT', entry({ baseAsset: 'XAU', contractType: 'TRADIFI_PERPETUAL', underlyingType: 'COMMODITY' })],
  ['DEFIUSDT', entry({ baseAsset: 'DEFI', underlyingType: 'INDEX' })],
  ['PREUSDT', entry({ baseAsset: 'PRE', underlyingType: 'PREMARKET' })],
  ['PREPERPUSDT', entry({ baseAsset: 'PREPERP', contractType: 'TRADIFI_PERPETUAL', underlyingType: 'PREMARKET' })],
  ['QTRUSDT', entry({ baseAsset: 'QTR', contractType: 'CURRENT_QUARTER' })],
  ['ODDUSDT', entry({ baseAsset: 'ODD', underlyingType: 'WEIRD' })],
  ['USDCUSDT', entry({ baseAsset: 'USDC' })],
  ['PAXGUSDT', entry({ baseAsset: 'PAXG' })],
  ['QUOTEUSDT', entry({ baseAsset: 'QUOTE', quoteAsset: 'USDC' })],
  ['BUSDT', entry({ baseAsset: 'B' })],
]);

/** Every class, with the expected include flag and reason. */
const FIXTURE: Array<[string, boolean, string]> = [
  ['BTCUSDT', true, 'exchange:perpetual-coin-usdt'],
  ['1000SHIBUSDT', true, 'exchange:perpetual-coin-usdt'],
  ['LUNA2USDT', true, 'exchange:perpetual-coin-usdt'],
  ['LUNCUSDT', true, 'exchange:perpetual-coin-usdt'],
  ['LUNCUSDTSETTLED', false, 'settled-folder'],
  ['AERGOUSDTSETTLEDSETTLED', false, 'settled-folder'],
  ['AAPLUSDT', false, 'exchange:tradfi'],
  ['XAUUSDT', false, 'exchange:tradfi'],
  ['DEFIUSDT', false, 'exchange:index'],
  ['PREUSDT', false, 'exchange:premarket'],
  ['PREPERPUSDT', false, 'exchange:tradfi'],
  ['QTRUSDT', false, 'exchange:contract-type-CURRENT_QUARTER'],
  ['ODDUSDT', false, 'exchange:underlying-WEIRD'],
  ['USDCUSDT', false, 'exchange:stable-or-gold'],
  ['PAXGUSDT', false, 'exchange:stable-or-gold'],
  ['QUOTEUSDT', false, 'exchange:quote-USDC'],
  ['LUNAUSDT', true, 'absent:crypto'],
  ['MATICUSDT', true, 'absent:crypto'],
  ['BLUEBIRDUSDT', false, 'absent:index'],
  ['FOOTBALLUSDT', false, 'absent:index'],
  ['DOTECOUSDT', false, 'absent:index'],
  ['NEWTHINGUSDT', false, 'unclassified-absent'],
  ['NEWTHINGUSDTSETTLED', false, 'settled-folder'],
  ['AUSDT', false, 'unclassified-absent'],
  ['BUSDT', true, 'exchange:perpetual-coin-usdt'],
  ['BTCUSDT_230331', false, 'shape:dated-quarterly'],
  ['ICPUSDT_SETTLED', false, 'shape:underscore-other'],
  ['BTCUSDC', false, 'shape:usdc-quoted'],
  ['BTCBUSD', false, 'shape:other-quote'],
  ['BTCUSD1', false, 'shape:other-quote'],
  ['BTCU', false, 'shape:other-quote'],
  ['ETHBTC', false, 'shape:other-quote'],
  ['币安USDT', false, 'shape:non-ascii'],
  ['btcusdt', false, 'shape:other-shape'],
  ['A' + 'B'.repeat(41) + 'USDT', false, 'shape:other-shape'],
];

describe('assetKey', () => {
  it('strips USDT and the multiplier prefixes in order', () => {
    expect(assetKey('1000SHIBUSDT')).toBe('SHIB');
    expect(assetKey('1MBABYDOGEUSDT')).toBe('BABYDOGE');
    expect(assetKey('1000000MOGUSDT')).toBe('MOG');
    expect(assetKey('1INCHUSDT')).toBe('1INCH');
    expect(assetKey('BTCUSDT')).toBe('BTC');
  });
});

describe('classifyFolder', () => {
  it.each(FIXTURE)('%s -> include %s (%s)', (name, include, reason) => {
    expect(classifyFolder(name, EXCHANGE)).toEqual({ include, reason });
  });

  it('classifies every fixture folder exactly once and the counts add up', async () => {
    const names = FIXTURE.map(([name]) => name);
    expect(new Set(names).size).toBe(names.length);

    const verdicts = names.map((name) => classifyFolder(name, EXCHANGE));
    for (const v of verdicts) {
      expect(typeof v.include).toBe('boolean');
      expect(v.reason.length).toBeGreaterThan(0);
    }

    const noFiles: Lister = { listPrefixes: async () => [], listKeys: async () => [] };
    const source = await buildUniverseSource(names, EXCHANGE, 'x', noFiles);
    expect(source.folders).toHaveLength(names.length);
    expect(source.counts.folders).toBe(names.length);
    expect(source.counts.included + source.counts.excluded).toBe(names.length);
    expect(source.counts.included).toBe(verdicts.filter((v) => v.include).length);
    expect(Object.values(source.counts.byReason).reduce((a, b) => a + b, 0)).toBe(names.length);
    expect(source.folders.filter((f) => f.include).length).toBe(source.counts.included);
  });

  it('holds the 28 header crypto tickers', () => {
    expect(ABSENT_CRYPTO_TICKERS.size).toBe(28);
  });
});

describe('listing keys', () => {
  it('reads months and days, ignoring CHECKSUM siblings and other symbols', () => {
    const keys = [
      'data/futures/um/monthly/klines/BTCUSDT/1d/BTCUSDT-1d-2020-02.zip',
      'data/futures/um/monthly/klines/BTCUSDT/1d/BTCUSDT-1d-2020-02.zip.CHECKSUM',
      'data/futures/um/monthly/klines/BTCUSDT/1d/BTCUSDT-1d-2020-01.zip',
      'data/futures/um/monthly/klines/BTCUSDT/1d/XBTCUSDT-1d-2020-03.zip',
    ];
    expect(keyDates(keys, 'BTCUSDT', '1d', 'month')).toEqual(['2020-01', '2020-02']);
    expect(keyDates(['a/BTCUSDT-1d-2020-01-05.zip'], 'BTCUSDT', '1d', 'day')).toEqual(['2020-01-05']);
    expect(keyDates(['a/BTCUSDT-1d-2020-01.zip'], 'BTCUSDT', '1d', 'day')).toEqual([]);
  });

  it('extracts folder names from prefixes', () => {
    const parent = 'data/futures/um/monthly/klines/';
    expect(folderNames([`${parent}BTCUSDT/`, `${parent}ETHUSDT/`, 'other/X/'], parent)).toEqual([
      'BTCUSDT',
      'ETHUSDT',
    ]);
  });
});

describe('buildUniverseSource', () => {
  const lister: Lister = {
    listPrefixes: async () => [],
    listKeys: async (prefix) => {
      if (prefix === 'data/futures/um/monthly/klines/LUNAUSDT/1d/') {
        return [
          'data/futures/um/monthly/klines/LUNAUSDT/1d/LUNAUSDT-1d-2022-04.zip',
          'data/futures/um/monthly/klines/LUNAUSDT/1d/LUNAUSDT-1d-2022-04.zip.CHECKSUM',
          'data/futures/um/monthly/klines/LUNAUSDT/1d/LUNAUSDT-1d-2022-05.zip',
        ];
      }
      if (prefix === 'data/futures/um/daily/klines/LUNAUSDT/1d/') {
        return [
          'data/futures/um/daily/klines/LUNAUSDT/1d/LUNAUSDT-1d-2022-05-10.zip',
          'data/futures/um/daily/klines/LUNAUSDT/1d/LUNAUSDT-1d-2022-05-12.zip',
        ];
      }
      if (prefix === 'data/futures/um/monthly/fundingRate/LUNAUSDT/') {
        return ['data/futures/um/monthly/fundingRate/LUNAUSDT/LUNAUSDT-fundingRate-2022-05.zip'];
      }
      return [];
    },
  };

  it('records exact months, daily first/last/count and funding months, with a stable hash', async () => {
    const a = await buildUniverseSource(['LUNAUSDT', 'BTCUSDT_230331'], EXCHANGE, 'abc', lister);
    const b = await buildUniverseSource(['BTCUSDT_230331', 'LUNAUSDT'], EXCHANGE, 'abc', lister);
    expect(a.sha256).toBe(b.sha256);
    expect(a.exchangeInfoSha256).toBe('abc');
    const luna = a.folders.find((f) => f.name === 'LUNAUSDT')!;
    expect(luna.klineMonths).toEqual(['2022-04', '2022-05']);
    expect(luna.dailyKlines).toEqual({ first: '2022-05-10', last: '2022-05-12', count: 2 });
    expect(luna.fundingMonths).toEqual(['2022-05']);
    expect(luna.exchange).toBeNull();
    const quarterly = a.folders.find((f) => f.name === 'BTCUSDT_230331')!;
    expect(quarterly.include).toBe(false);
    expect(quarterly.klineMonths).toEqual([]);
  });
});

describe('exchangeMapFromJson', () => {
  it('keeps the fields the classification needs', () => {
    const map = exchangeMapFromJson({
      symbols: [
        {
          symbol: 'BTCUSDT',
          pair: 'BTCUSDT',
          contractType: 'PERPETUAL',
          underlyingType: 'COIN',
          quoteAsset: 'USDT',
          baseAsset: 'BTC',
          status: 'TRADING',
          onboardDate: 1567965300000,
          deliveryDate: 4133404800000,
          filters: [],
        },
      ],
    });
    expect(map.get('BTCUSDT')).toEqual(entry({ baseAsset: 'BTC' }));
    expect(() => exchangeMapFromJson({})).toThrow();
  });
});
