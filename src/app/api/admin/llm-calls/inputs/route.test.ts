// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

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
});
