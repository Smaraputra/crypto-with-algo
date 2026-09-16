import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Hoist mock variables so they're available inside vi.mock() factories
const {
  mockConnectDB,
  mockAuth,
  mockAlignTimestamp,
  mockBulkUpsertSnapshots,
  mockFetchFundingRate,
  mockFetchLongShortRatio,
  mockFetchOpenInterestHistory,
  mockFetchFearGreedHistory,
} = vi.hoisted(() => ({
  mockConnectDB: vi.fn(),
  mockAuth: vi.fn(),
  mockAlignTimestamp: vi.fn((ts: number) => ts),
  mockBulkUpsertSnapshots: vi.fn(),
  mockFetchFundingRate: vi.fn(),
  mockFetchLongShortRatio: vi.fn(),
  mockFetchOpenInterestHistory: vi.fn(),
  mockFetchFearGreedHistory: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: () => mockConnectDB(),
}));

vi.mock('@/lib/auth', () => ({
  auth: () => mockAuth(),
}));

vi.mock('@/lib/historical-snapshots', () => ({
  alignTimestamp: mockAlignTimestamp,
  bulkUpsertSnapshots: mockBulkUpsertSnapshots,
}));

vi.mock('@/lib/binance-futures', () => ({
  fetchFundingRate: mockFetchFundingRate,
  fetchLongShortRatio: mockFetchLongShortRatio,
  fetchOpenInterestHistory: mockFetchOpenInterestHistory,
}));

vi.mock('@/lib/external/fear-greed', () => ({
  fetchFearAndGreedHistory: (days: number) => mockFetchFearGreedHistory(days),
}));

import { POST } from './route';

describe('POST /api/admin/backfill-snapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    // Default mocks for Binance data
    mockFetchFundingRate.mockResolvedValue([]);
    mockFetchLongShortRatio.mockResolvedValue([]);
    mockFetchOpenInterestHistory.mockResolvedValue([]);
    const todayUtc = Math.floor(Date.now() / 86400000) * 86400000;
    mockFetchFearGreedHistory.mockResolvedValue([
      { timestamp: todayUtc, fearGreedIndex: 50, label: 'Neutral' },
      { timestamp: todayUtc - 86400000, fearGreedIndex: 48, label: 'Fear' },
    ]);
    mockBulkUpsertSnapshots.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.ADMIN_EMAIL;
  });

  function makeRequest(body: unknown) {
    return new NextRequest('http://localhost:3000/api/admin/backfill-snapshots', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  it('should reject unauthenticated users', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue(null);

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 1 }));
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it('should reject users without email', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: {} });

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 1 }));
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('should reject non-admin users', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'user@example.com' } });

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 1 }));
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('should reject invalid request body - missing symbols', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const response = await POST(makeRequest({ intervals: ['1h'], months: 1 }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid request body');
    expect(data.issues).toBeDefined();
  });

  it('should reject empty symbols array', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const response = await POST(makeRequest({ symbols: [], intervals: ['1h'], months: 1 }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid request body');
  });

  it('should reject invalid interval values', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['2h'], months: 1 }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid request body');
  });

  it('should reject months out of range', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 60 }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid request body');
  });

  it('should reject symbols array exceeding max length', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const symbols = Array.from({ length: 21 }, (_, i) => `SYM${i}USDT`);
    const response = await POST(makeRequest({ symbols, intervals: ['1h'], months: 1 }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid request body');
  });

  function asAdmin() {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
  }

  function upserted() {
    return mockBulkUpsertSnapshots.mock.calls.flatMap((call) => call[0] as Array<{ timestamp: number; data: Record<string, unknown> }>);
  }

  it('should successfully backfill snapshots', async () => {
    asAdmin();

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 1 }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.symbols).toBe(1);
    expect(data.intervals).toBe(1);
    expect(data.errors).toBe(0);
    expect(mockConnectDB).toHaveBeenCalled();
    expect(data.ingested).toBe(upserted().length);
  });

  it('writes a snapshot for every bar of the window, not just the recent futures history', async () => {
    // Regression: bars were taken from the long/short response (max 500), so
    // months never extended history.
    asAdmin();
    mockFetchLongShortRatio.mockResolvedValue([]);

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['4h'], months: 24 }));
    const data = await response.json();

    const expectedBars = Math.floor((24 * 30 * 86400000) / (4 * 3600000));
    expect(data.ingested).toBeGreaterThanOrEqual(expectedBars);
    expect(data.ingested).toBeLessThanOrEqual(expectedBars + 1);
    expect(data.ingested).toBeGreaterThan(500);
  });

  it('writes large windows in chunks', async () => {
    asAdmin();

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 48 }));
    const data = await response.json();

    expect(mockBulkUpsertSnapshots.mock.calls.length).toBeGreaterThan(1);
    for (const call of mockBulkUpsertSnapshots.mock.calls) {
      expect((call[0] as unknown[]).length).toBeLessThanOrEqual(5000);
    }
    expect(upserted()).toHaveLength(data.ingested);
  });

  it('pages funding once per symbol, shared across intervals', async () => {
    asAdmin();

    await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1h', '4h', '1d'], months: 1 }));

    expect(mockFetchFundingRate).toHaveBeenCalledTimes(1);
    expect(mockFetchFundingRate.mock.calls[0][0]).toBe('BTCUSDT');
    expect(mockFetchFundingRate.mock.calls[0][1]).toBe(1000);
    // The route pauses a second between symbol/interval pairs.
  }, 10_000);

  it('requests the recent long/short and open interest history per interval', async () => {
    asAdmin();

    await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['4h'], months: 1 }));

    expect(mockFetchLongShortRatio).toHaveBeenCalledWith('BTCUSDT', '4h', 500);
    expect(mockFetchOpenInterestHistory).toHaveBeenCalledWith('BTCUSDT', '4h', 500);
  });

  it('asks for enough Fear & Greed history to cover the window plus carry-forward', async () => {
    asAdmin();

    await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1d'], months: 48 }));

    expect(mockFetchFearGreedHistory).toHaveBeenCalledWith(48 * 31 + 3);
  });

  it('should handle multiple symbols and intervals', async () => {
    asAdmin();

    const response = await POST(makeRequest({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      intervals: ['1h', '4h'],
      months: 1,
    }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.symbols).toBe(2);
    expect(data.intervals).toBe(2);
  });

  it('still writes Fear & Greed when funding history fails', async () => {
    asAdmin();
    mockFetchFundingRate.mockRejectedValue(new Error('API error'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 1 }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.errors).toBe(0);
    expect(data.coverage.fundingRate).toBe(0);
    expect(data.coverage.fearGreed).toBeGreaterThan(0);
  });

  it('still writes bars when long/short and open interest fail', async () => {
    asAdmin();
    mockFetchLongShortRatio.mockRejectedValue(new Error('API error'));
    mockFetchOpenInterestHistory.mockRejectedValue(new Error('API error'));

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 1 }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.ingested).toBeGreaterThan(0);
    expect(data.coverage.longShortRatio).toBe(0);
  });

  it('should handle a failing fear and greed fetch', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    mockFetchFearGreedHistory.mockRejectedValue(new Error('API down'));
    mockFetchLongShortRatio.mockResolvedValue([]);

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 1 }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
  });

  it('should handle complete failure for a symbol/interval pair', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    // All API calls fail for a pair
    mockFetchFundingRate.mockRejectedValue(new Error('API error'));
    mockFetchLongShortRatio.mockRejectedValue(new Error('API error'));
    mockFetchOpenInterestHistory.mockRejectedValue(new Error('API error'));
    // bulkUpsertSnapshots also fails
    mockBulkUpsertSnapshots.mockRejectedValue(new Error('DB write error'));

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 1 }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.errors).toBe(1);
  });

  it('should handle database connection errors', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockConnectDB.mockRejectedValue(new Error('Connection failed'));

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 1 }));
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Backfill failed');
  });

  it('should handle JSON parse errors', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const request = new NextRequest('http://localhost:3000/api/admin/backfill-snapshots', {
      method: 'POST',
      body: 'invalid json',
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Backfill failed');
  });
});
