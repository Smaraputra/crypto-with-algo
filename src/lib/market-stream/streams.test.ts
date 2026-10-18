import { describe, expect, it } from 'vitest';
import {
  parseStreams,
  upstreamUrl,
  sseData,
  SSE_PING,
  STREAM_INTERVALS,
  tickerStream,
  klineStream,
} from './streams';

describe('streams parsing and formatting', () => {
  describe('parseStreams', () => {
    it('parses valid multiple streams', () => {
      const result = parseStreams('btcusdt@ticker/ethusdt@kline_1h');
      expect(result).toEqual({
        ok: true,
        streams: ['btcusdt@ticker', 'ethusdt@kline_1h'],
      });
    });

    it('lowercases uppercase streams', () => {
      const result = parseStreams('BTCUSDT@ticker');
      expect(result).toEqual({
        ok: true,
        streams: ['btcusdt@ticker'],
      });
    });

    it('removes duplicates while preserving order', () => {
      const result = parseStreams('btcusdt@ticker/ethusdt@kline_1h/BTCUSDT@ticker');
      expect(result).toEqual({
        ok: true,
        streams: ['btcusdt@ticker', 'ethusdt@kline_1h'],
      });
    });

    it('ignores trailing slash', () => {
      const result = parseStreams('btcusdt@ticker/');
      expect(result).toEqual({
        ok: true,
        streams: ['btcusdt@ticker'],
      });
    });

    it('returns error when param is null', () => {
      expect(parseStreams(null)).toEqual({
        ok: false,
        error: 'streams is required',
      });
    });

    it('returns error when param is empty string', () => {
      expect(parseStreams('')).toEqual({
        ok: false,
        error: 'streams is required',
      });
    });

    it('returns error when more than 100 streams provided', () => {
      const streamList = Array.from({ length: 101 }, (_, i) => `s${i + 10}@ticker`).join('/');
      expect(parseStreams(streamList)).toEqual({
        ok: false,
        error: 'at most 100 streams',
      });
    });

    it('accepts 100 distinct streams', () => {
      const streamList = Array.from({ length: 100 }, (_, i) => `s${i + 10}@ticker`).join('/');
      const result = parseStreams(streamList);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.streams).toHaveLength(100);
      }
    });

    it('returns error for unsupported stream type', () => {
      expect(parseStreams('btcusdt@depth')).toEqual({
        ok: false,
        error: 'invalid stream: btcusdt@depth',
      });
    });

    it('returns error for unsupported kline interval', () => {
      expect(parseStreams('btcusdt@kline_7m')).toEqual({
        ok: false,
        error: 'invalid stream: btcusdt@kline_7m',
      });
    });

    it('returns error for invalid symbol character', () => {
      expect(parseStreams('btc-usdt@ticker')).toEqual({
        ok: false,
        error: 'invalid stream: btc-usdt@ticker',
      });
    });

    it('returns error for symbol too short', () => {
      expect(parseStreams('b@ticker')).toEqual({
        ok: false,
        error: 'invalid stream: b@ticker',
      });
    });

    it('preserves monthly 1M interval case when lowercasing symbol', () => {
      expect(parseStreams('BTCUSDT@kline_1M')).toEqual({
        ok: true,
        streams: ['btcusdt@kline_1M'],
      });
    });

    it('preserves both 1M and 1m intervals during deduplication in order', () => {
      expect(parseStreams('btcusdt@kline_1M/btcusdt@kline_1m')).toEqual({
        ok: true,
        streams: ['btcusdt@kline_1M', 'btcusdt@kline_1m'],
      });
    });

    it('rejects invalid interval case such as 1H', () => {
      expect(parseStreams('btcusdt@kline_1H')).toEqual({
        ok: false,
        error: 'invalid stream: btcusdt@kline_1H',
      });
    });

    it('lowercases uppercase KLINE prefix while keeping interval', () => {
      expect(parseStreams('ETHUSDT@KLINE_4h')).toEqual({
        ok: true,
        streams: ['ethusdt@kline_4h'],
      });
    });

    it('accepts every supported interval while keeping its case', () => {
      const param = STREAM_INTERVALS.map((i) => `btcusdt@kline_${i}`).join('/');
      expect(parseStreams(param)).toEqual({
        ok: true,
        streams: STREAM_INTERVALS.map((i) => `btcusdt@kline_${i}`),
      });
    });
  });

  describe('upstreamUrl', () => {
    it('constructs correct upstream url stripping trailing slash from base', () => {
      expect(upstreamUrl('wss://x:9443/', ['a@ticker', 'b@ticker'])).toBe(
        'wss://x:9443/stream?streams=a@ticker/b@ticker'
      );
    });
  });

  describe('sseData', () => {
    it('formats data into an SSE frame', () => {
      expect(sseData('{"a":1}')).toBe('data: {"a":1}\n\n');
    });
  });

  describe('SSE_PING', () => {
    it('is a ping comment frame', () => {
      expect(SSE_PING).toBe(': ping\n\n');
    });
  });

  describe('stream helpers', () => {
    it('formats ticker stream', () => {
      expect(tickerStream('BTCUSDT')).toBe('btcusdt@ticker');
    });

    it('formats kline stream preserving interval case', () => {
      expect(klineStream('BTCUSDT', '1M')).toBe('btcusdt@kline_1M');
      expect(klineStream('ethUSDT', '1h')).toBe('ethusdt@kline_1h');
    });
  });
});
