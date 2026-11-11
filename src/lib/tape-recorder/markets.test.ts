// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadMarkets, MAX_MARKETS, parseMarkets } from './markets';

const GOOD = [
  { coin: 'BTC', lighterMarketId: 1, binanceSymbol: 'BTCUSDT' },
  { coin: 'NVDA', lighterMarketId: 123, binanceSymbol: null },
];

describe('parseMarkets', () => {
  it('accepts a valid file, including a Lighter-only market', () => {
    expect(parseMarkets(JSON.stringify(GOOD))).toEqual(GOOD);
  });

  it('accepts market id 0', () => {
    expect(parseMarkets('[{"coin":"ETH","lighterMarketId":0,"binanceSymbol":"ETHUSDT"}]')).toHaveLength(1);
  });

  it.each([
    ['not JSON', '{nope', 'not valid JSON'],
    ['not an array', '{}', 'must be a JSON array'],
    ['empty', '[]', 'is empty'],
    ['entry not an object', '[1]', 'entry 0: must be an object'],
    ['missing coin', '[{"lighterMarketId":1,"binanceSymbol":null}]', 'coin must be'],
    ['bad market id', '[{"coin":"A","lighterMarketId":"1","binanceSymbol":null}]', 'lighterMarketId must be a non-negative integer'],
    ['fractional market id', '[{"coin":"A","lighterMarketId":1.5,"binanceSymbol":null}]', 'lighterMarketId must be'],
    ['negative market id', '[{"coin":"A","lighterMarketId":-1,"binanceSymbol":null}]', 'lighterMarketId must be'],
    ['binanceSymbol absent', '[{"coin":"A","lighterMarketId":1}]', 'binanceSymbol must be null'],
    ['lower-case symbol', '[{"coin":"A","lighterMarketId":1,"binanceSymbol":"btcusdt"}]', 'binanceSymbol must be null'],
    ['unknown field', '[{"coin":"A","lighterMarketId":1,"binanceSymbol":null,"extra":1}]', 'unknown field "extra"'],
  ])('rejects %s', (_name, text, message) => {
    expect(() => parseMarkets(text)).toThrow(message);
  });

  it('rejects duplicates and lists every problem at once', () => {
    const text = JSON.stringify([
      { coin: 'BTC', lighterMarketId: 1, binanceSymbol: 'BTCUSDT' },
      { coin: 'BTC', lighterMarketId: 2, binanceSymbol: 'ETHUSDT' },
      { coin: 'ETH', lighterMarketId: 1, binanceSymbol: 'BTCUSDT' },
    ]);
    let message = '';
    try {
      parseMarkets(text, 'markets.json');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('markets.json is invalid');
    expect(message).toContain('entry 1: duplicate coin "BTC"');
    expect(message).toContain('entry 2: duplicate lighterMarketId 1');
    expect(message).toContain('entry 2: duplicate binanceSymbol "BTCUSDT"');
  });
});

describe('market count limit', () => {
  const many = (n: number) =>
    JSON.stringify(Array.from({ length: n }, (_, i) => ({ coin: `C${i}`, lighterMarketId: i, binanceSymbol: null })));

  it('accepts 249 markets and rejects 250 with a clear message', () => {
    expect(MAX_MARKETS).toBe(249);
    expect(parseMarkets(many(249))).toHaveLength(249);
    expect(() => parseMarkets(many(250))).toThrow(/250 markets, more than the 249 one Lighter connection can carry \(500 subscriptions, 2 per market\)/);
  });
});

describe('loadMarkets', () => {
  it('reads a file and names the path when it is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tape-markets-'));
    try {
      const file = path.join(dir, 'markets.json');
      fs.writeFileSync(file, JSON.stringify(GOOD));
      expect(loadMarkets(file)).toEqual(GOOD);
      expect(() => loadMarkets(path.join(dir, 'missing.json'))).toThrow('cannot read markets file');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
