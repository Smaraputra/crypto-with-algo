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
  mockFetchFearGreedIndex,
} = vi.hoisted(() => ({
  mockConnectDB: vi.fn(),
  mockAuth: vi.fn(),
  mockAlignTimestamp: vi.fn((ts: number) => ts),
  mockBulkUpsertSnapshots: vi.fn(),
  mockFetchFundingRate: vi.fn(),
  mockFetchLongShortRatio: vi.fn(),
  mockFetchOpenInterestHistory: vi.fn(),
  mockFetchFearGreedIndex: vi.fn(),
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

vi.mock('@/lib/sentiment-analysis', () => ({
  fetchFearGreedIndex: () => mockFetchFearGreedIndex(),
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
    mockFetchFearGreedIndex.mockResolvedValue({ value: 50, valueClassification: 'Neutral' });
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
    mockAuth.mockResolvedValue(null);

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 1 }));
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it('should reject users without email', async () => {
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

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 15 }));
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

  it('should successfully backfill snapshots', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const now = Date.now();
    mockFetchLongShortRatio.mockResolvedValue([
      { timestamp: now - 3600000, longShortRatio: 1.2, longAccount: 0.55, shortAccount: 0.45 },
    ]);
    mockFetchFundingRate.mockResolvedValue([
      { fundingTime: now - 3600000, fundingRate: 0.001, markPrice: 50000 },
    ]);
    mockFetchOpenInterestHistory.mockResolvedValue([
      { timestamp: now - 3600000, sumOpenInterest: 100000, sumOpenInterestValue: 5000000000 },
    ]);

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 1 }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.symbols).toBe(1);
    expect(data.intervals).toBe(1);
    expect(data.ingested).toBeGreaterThanOrEqual(1);
    expect(data.errors).toBe(0);
    expect(mockConnectDB).toHaveBeenCalled();
    expect(mockBulkUpsertSnapshots).toHaveBeenCalled();
  });

  it('should handle multiple symbols and intervals', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    mockFetchLongShortRatio.mockResolvedValue([]);
    mockFetchFundingRate.mockResolvedValue([]);
    mockFetchOpenInterestHistory.mockResolvedValue([]);

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

  it('should handle partial API failures gracefully', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    // Funding rate fails, others succeed
    mockFetchFundingRate.mockRejectedValue(new Error('API error'));
    mockFetchLongShortRatio.mockResolvedValue([
      { timestamp: Date.now() - 3600000, longShortRatio: 1.2, longAccount: 0.55, shortAccount: 0.45 },
    ]);
    mockFetchOpenInterestHistory.mockResolvedValue([]);

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 1 }));
    const data = await response.json();

    // Should still succeed because Promise.allSettled is used
    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
  });

  it('should include fear and greed data when available', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const now = Date.now();
    mockFetchLongShortRatio.mockResolvedValue([
      { timestamp: now, longShortRatio: 1.0, longAccount: 0.5, shortAccount: 0.5 },
    ]);
    mockFetchFearGreedIndex.mockResolvedValue({ value: 75, valueClassification: 'Greed' });

    const response = await POST(makeRequest({ symbols: ['BTCUSDT'], intervals: ['1h'], months: 1 }));
    await response.json();

    expect(response.status).toBe(200);
    expect(mockBulkUpsertSnapshots).toHaveBeenCalled();
  });

  it('should handle null fear and greed data', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    mockFetchFearGreedIndex.mockResolvedValue(null);
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
