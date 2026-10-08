// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));

import { DEFAULT_TOP_N, MAX_TOP_N, readRecorderEnv } from './market-recorder';

describe('readRecorderEnv', () => {
  it('defaults to the top 50 on the /market route and the public REST host', () => {
    expect(readRecorderEnv({})).toEqual({
      topN: DEFAULT_TOP_N,
      wsBaseUrl: 'wss://fstream.binance.com/market',
      restBaseUrl: 'https://fapi.binance.com',
    });
    expect(DEFAULT_TOP_N).toBe(50);
  });

  it('reads the overrides', () => {
    expect(
      readRecorderEnv({
        RECORDER_TOP_N: ' 20 ',
        BINANCE_FUTURES_WS_URL: 'wss://proxy.test/market',
        BINANCE_FUTURES_API_URL: 'https://proxy.test',
      })
    ).toEqual({ topN: 20, wsBaseUrl: 'wss://proxy.test/market', restBaseUrl: 'https://proxy.test' });
  });

  it('treats an empty override as unset', () => {
    expect(readRecorderEnv({ RECORDER_TOP_N: '', BINANCE_FUTURES_WS_URL: '  ' }).topN).toBe(DEFAULT_TOP_N);
  });

  it.each([['0'], [String(MAX_TOP_N + 1)], ['ten'], ['5.5'], ['-3']])('rejects RECORDER_TOP_N=%s', (value) => {
    expect(() => readRecorderEnv({ RECORDER_TOP_N: value })).toThrow(/RECORDER_TOP_N/);
  });

  it('rejects a WebSocket base that is not a ws:// or wss:// URL', () => {
    expect(() => readRecorderEnv({ BINANCE_FUTURES_WS_URL: 'https://fstream.binance.com/market' })).toThrow(
      /BINANCE_FUTURES_WS_URL/
    );
  });
});
