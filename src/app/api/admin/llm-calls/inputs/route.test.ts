// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { PacketDeps } from './packet';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));
const mockAuthorize = vi.fn();
vi.mock('../auth', () => ({ authorizeLlmPanel: (...args: unknown[]) => mockAuthorize(...args) }));
const mockBuild = vi.fn();
vi.mock('./packet', () => ({ buildInputsPacket: (...args: unknown[]) => mockBuild(...args) }));
vi.mock('@/lib/candle-ingestion', () => ({ getCandles: vi.fn(), dropOpenBars: vi.fn() }));
vi.mock('@/lib/models/global-signal', () => ({ GlobalSignal: { findOne: vi.fn() } }));
vi.mock('@/lib/models/historical-snapshot', () => ({ HistoricalSnapshot: { findOne: vi.fn() } }));
vi.mock('@/lib/external/crypto-news', () => ({ fetchCryptoNews: vi.fn() }));

import { GET } from './route';
import { GlobalSignal } from '@/lib/models/global-signal';
import { HistoricalSnapshot } from '@/lib/models/historical-snapshot';
import { fetchCryptoNews } from '@/lib/external/crypto-news';
import { getCandles } from '@/lib/candle-ingestion';

function req(query: string): NextRequest {
  return new NextRequest(new URL(`http://localhost/api/admin/llm-calls/inputs${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthorize.mockResolvedValue({ ok: true, via: 'secret' });
  mockBuild.mockResolvedValue({ symbol: 'BTCUSDT', interval: '1h', inputsHash: 'x' });
});

describe('GET /api/admin/llm-calls/inputs', () => {
  it('rejects an unauthorized caller with the auth status and body', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, status: 401, body: { error: 'Unauthorized' } });
    const res = await GET(req('?symbol=BTCUSDT&interval=1h'));
    expect(res.status).toBe(401);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it('rejects a bad symbol or an interval outside 1h, 4h, 1d with 400', async () => {
    expect((await GET(req('?symbol=btc&interval=1h'))).status).toBe(400);
    expect((await GET(req('?symbol=BTCUSDT&interval=5m'))).status).toBe(400);
  });

  it('returns 404 when no closed bar exists', async () => {
    mockBuild.mockResolvedValue(null);
    expect((await GET(req('?symbol=BTCUSDT&interval=1h'))).status).toBe(404);
  });

  it('returns the packet', async () => {
    const res = await GET(req('?symbol=BTCUSDT&interval=1h'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ symbol: 'BTCUSDT', interval: '1h', inputsHash: 'x' });
  });

  it('scopes the global signal query to the trading style, not just the interval', async () => {
    vi.mocked(GlobalSignal.findOne).mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(null) }),
    } as unknown as ReturnType<typeof GlobalSignal.findOne>);

    await GET(req('?symbol=BTCUSDT&interval=1d'));
    const deps = mockBuild.mock.calls[0][0] as PacketDeps;
    await deps.findLatestSignal('BTCUSDT', '1d', 1735689600000);

    // 1d and 4h can share a candleTimestamp (swing_trading writes both 4h and
    // 1d, position_trading writes 1d), so the query must pin the style too or
    // the sort cannot break the tie and the wrong style's signal can win.
    expect(GlobalSignal.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ tradingStyle: 'position_trading' })
    );
  });

  it('wires findLatestSnapshot to HistoricalSnapshot.findOne with the mapped interval and atOrBefore', async () => {
    vi.mocked(HistoricalSnapshot.findOne).mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(null) }),
    } as unknown as ReturnType<typeof HistoricalSnapshot.findOne>);

    await GET(req('?symbol=BTCUSDT&interval=1h'));
    const deps = mockBuild.mock.calls[0][0] as PacketDeps;
    await deps.findLatestSnapshot('BTCUSDT', '1h', 1735689600000);

    expect(HistoricalSnapshot.findOne).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      interval: '1h',
      timestamp: { $lte: 1735689600000 },
    });
  });

  it('wires fetchNews to fetchCryptoNews with the stripped currency and a limit of 200', async () => {
    vi.mocked(fetchCryptoNews).mockResolvedValue([]);

    await GET(req('?symbol=BTCUSDT&interval=1h'));
    const deps = mockBuild.mock.calls[0][0] as PacketDeps;
    await deps.fetchNews('BTCUSDT');

    expect(fetchCryptoNews).toHaveBeenCalledWith('BTC', 200);
  });

  it('wires getCandles to the ingestion getCandles with the limit forwarded', async () => {
    vi.mocked(getCandles).mockResolvedValue([]);

    await GET(req('?symbol=BTCUSDT&interval=1h'));
    const deps = mockBuild.mock.calls[0][0] as PacketDeps;
    await deps.getCandles('BTCUSDT', '1h', 61);

    expect(getCandles).toHaveBeenCalledWith('BTCUSDT', '1h', undefined, undefined, 61);
  });

  it('returns 500 without leaking the error message when building the packet throws', async () => {
    mockBuild.mockRejectedValue(new Error('boom, do not leak this'));

    const res = await GET(req('?symbol=BTCUSDT&interval=1h'));

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(json)).not.toContain('boom');
  });
});
