import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { readTapeEnv } from './tape-recorder';

const BASE = { TAPE_DIR: '/tape', TAPE_MARKETS_FILE: '/tape/markets.json' };

describe('readTapeEnv', () => {
  it('applies the defaults', () => {
    expect(readTapeEnv(BASE)).toEqual({
      dir: path.resolve('/tape'),
      marketsFile: path.resolve('/tape/markets.json'),
      lighterUrl: 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true',
      binanceUrl: 'wss://fstream.binance.com/public',
      msgsPerMinute: 150,
      staleAfterMs: 30_000,
      softLimitBytes: 4 * 1024 * 1024,
      minFreeBytes: 10 * 1024 ** 3,
    });
  });

  it('reads the overrides', () => {
    const env = readTapeEnv({
      ...BASE,
      TAPE_LIGHTER_WS_URL: 'ws://localhost:9000/stream',
      TAPE_BINANCE_WS_URL: 'wss://proxy.example/public',
      TAPE_LIGHTER_MSGS_PER_MIN: '100',
      TAPE_STALE_AFTER_MS: '45000',
      TAPE_BUFFER_SOFT_MB: '6',
      TAPE_MIN_FREE_GB: '25',
    });
    expect(env).toMatchObject({
      lighterUrl: 'ws://localhost:9000/stream',
      binanceUrl: 'wss://proxy.example/public',
      msgsPerMinute: 100,
      staleAfterMs: 45_000,
      softLimitBytes: 6 * 1024 * 1024,
      minFreeBytes: 25 * 1024 ** 3,
    });
  });

  it('keeps the worst-case buffer memory under half of a 512 MB container', () => {
    // Hard limit is 4x the soft limit per stream; 10 streams are open at an hour change.
    const { softLimitBytes } = readTapeEnv({ ...BASE, TAPE_BUFFER_SOFT_MB: '6' });
    expect(softLimitBytes * 4 * 10).toBeLessThanOrEqual(256 * 1024 * 1024);
  });

  it('allows the disk floor to be switched off', () => {
    expect(readTapeEnv({ ...BASE, TAPE_MIN_FREE_GB: '0' }).minFreeBytes).toBe(0);
  });

  it('requires the directory and the markets file', () => {
    expect(() => readTapeEnv({ TAPE_MARKETS_FILE: '/m.json' })).toThrow('TAPE_DIR is required');
    expect(() => readTapeEnv({ TAPE_DIR: '/tape' })).toThrow('TAPE_MARKETS_FILE is required');
    expect(() => readTapeEnv({ TAPE_DIR: ' ', TAPE_MARKETS_FILE: '/m.json' })).toThrow('TAPE_DIR is required');
  });

  it.each([
    ['TAPE_LIGHTER_MSGS_PER_MIN', 'many', 'must be a whole number'],
    ['TAPE_LIGHTER_MSGS_PER_MIN', '200', 'must be 1 to 190'],
    ['TAPE_LIGHTER_MSGS_PER_MIN', '0', 'must be 1 to 190'],
    ['TAPE_STALE_AFTER_MS', '100', 'must be 5000 to 600000'],
    ['TAPE_BUFFER_SOFT_MB', '0', 'must be 1 to 6'],
    ['TAPE_BUFFER_SOFT_MB', '7', 'must be 1 to 6'],
    ['TAPE_MIN_FREE_GB', '-1', 'must be a whole number'],
    ['TAPE_MIN_FREE_GB', '5000', 'must be 0 to 1000'],
    ['TAPE_LIGHTER_WS_URL', 'https://x', 'must start with wss://'],
    ['TAPE_BINANCE_WS_URL', 'fstream.binance.com', 'must start with wss://'],
  ])('rejects %s=%s', (key, value, message) => {
    expect(() => readTapeEnv({ ...BASE, [key]: value })).toThrow(message);
  });
});
