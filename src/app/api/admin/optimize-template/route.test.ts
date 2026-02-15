import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { POST } from './route';

// Mock dependencies
const mockConnectDB = vi.fn();
vi.mock('@/lib/mongodb', () => ({
  connectDB: () => mockConnectDB(),
}));

const mockAuth = vi.fn();
vi.mock('@/lib/auth', () => ({
  auth: () => mockAuth(),
}));

const mockJobCreate = vi.fn();
const mockJobSave = vi.fn();
vi.mock('@/lib/models/optimization-job', () => ({
  OptimizationJob: {
    create: (...args: unknown[]) => mockJobCreate(...args),
  },
}));

const mockGetCandles = vi.fn();
const mockBackfillCandles = vi.fn();
const mockGetCandleRange = vi.fn();
vi.mock('@/lib/candle-ingestion', () => ({
  getCandles: (...args: unknown[]) => mockGetCandles(...args),
  backfillCandles: (...args: unknown[]) => mockBackfillCandles(...args),
  getCandleRange: (...args: unknown[]) => mockGetCandleRange(...args),
}));

const mockRunWalkForward = vi.fn();
vi.mock('@/lib/optimization/walk-forward', () => ({
  runWalkForward: (...args: unknown[]) => mockRunWalkForward(...args),
}));

const mockCreateTemplateVersion = vi.fn();
const mockMarkResultsAsContributors = vi.fn();
vi.mock('@/lib/optimization/template-versioning', () => ({
  createTemplateVersion: (...args: unknown[]) => mockCreateTemplateVersion(...args),
  markResultsAsContributors: (...args: unknown[]) => mockMarkResultsAsContributors(...args),
}));

vi.mock('@/lib/models/signal-template', () => ({
  DEFAULT_TEMPLATE_THRESHOLDS: {
    scalping: { buyThreshold: 0.6, sellThreshold: -0.6 },
    day_trading: { buyThreshold: 0.5, sellThreshold: -0.5 },
    swing_trading: { buyThreshold: 0.4, sellThreshold: -0.4 },
    position_trading: { buyThreshold: 0.3, sellThreshold: -0.3 },
  },
}));

vi.mock('@/types/optimization', () => ({
  DEFAULT_OPTIMIZATION_CONFIG: {
    minTrainingBars: 300,
    testWindowBars: 100,
    stepSizeBars: 300,
    candidatesPerWindow: 50,
    constraintPercent: 0.2,
  },
}));

function generateCandles(count: number) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    timestamp: now - (count - i) * 60000,
    open: 50000 + i,
    high: 50100 + i,
    low: 49900 + i,
    close: 50050 + i,
    volume: 100,
  }));
}

describe('POST /api/admin/optimize-template', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockGetCandleRange.mockResolvedValue({ oldest: Date.now() - 365 * 24 * 3600000, newest: Date.now() });
    mockBackfillCandles.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.ADMIN_EMAIL;
  });

  function makeRequest(body: unknown) {
    return new Request('http://localhost:3000/api/admin/optimize-template', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  it('should reject unauthenticated users', async () => {
    mockAuth.mockResolvedValue(null);

    const response = await POST(makeRequest({
      tradingStyle: 'scalping', symbol: 'BTCUSDT', interval: '1m', months: 6,
    }));
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it('should reject non-admin users', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'user@example.com' } });

    const response = await POST(makeRequest({
      tradingStyle: 'scalping', symbol: 'BTCUSDT', interval: '1m', months: 6,
    }));
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('should reject invalid trading style', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const response = await POST(makeRequest({
      tradingStyle: 'invalid_style', symbol: 'BTCUSDT', interval: '1m', months: 6,
    }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid request');
    expect(data.issues).toBeDefined();
  });

  it('should reject invalid interval', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const response = await POST(makeRequest({
      tradingStyle: 'scalping', symbol: 'BTCUSDT', interval: '2m', months: 6,
    }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid request');
  });

  it('should reject months out of range', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const response = await POST(makeRequest({
      tradingStyle: 'scalping', symbol: 'BTCUSDT', interval: '1m', months: 15,
    }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid request');
  });

  it('should reject missing symbol', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const response = await POST(makeRequest({
      tradingStyle: 'scalping', symbol: '', interval: '1m', months: 6,
    }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid request');
  });

  it('should return 400 when insufficient candle data', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    // Return fewer candles than required (300 + 100 = 400 minimum)
    mockGetCandles.mockResolvedValue(generateCandles(200));

    const response = await POST(makeRequest({
      tradingStyle: 'scalping', symbol: 'BTCUSDT', interval: '1m', months: 6,
    }));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Insufficient data');
    expect(data.message).toContain('Need at least');
  });

  it('should backfill candles when data is missing', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    // No existing data
    mockGetCandleRange.mockResolvedValue({ oldest: null, newest: null });
    mockGetCandles.mockResolvedValue(generateCandles(200)); // Still insufficient

    const response = await POST(makeRequest({
      tradingStyle: 'scalping', symbol: 'BTCUSDT', interval: '1m', months: 6,
    }));

    // Should have attempted backfill
    expect(mockBackfillCandles).toHaveBeenCalledWith('BTCUSDT', '1m', 6);
    // Still fails because not enough data
    expect(response.status).toBe(400);
  });

  it('should create job, run optimization, and return results on success', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const candles = generateCandles(500);
    mockGetCandles.mockResolvedValue(candles);

    const mockJob = {
      _id: { toString: () => 'job123' },
      status: 'pending',
      startedAt: null,
      completedAt: null,
      optimizedWeights: null,
      ensembleResults: [],
      templateVersion: null,
      error: null,
      progress: { candidatesTested: 150, validResults: 60 },
      save: mockJobSave,
    };
    mockJobCreate.mockResolvedValue(mockJob);
    mockJobSave.mockResolvedValue(mockJob);

    const walkForwardResult = {
      optimizedWeights: { rsi: 0.3, macd: 0.4, volume: 0.3 },
      ensembleResults: [
        { _id: 'result1', metrics: { sharpeRatio: 1.5, winRate: 0.6 } },
        { _id: 'result2', metrics: { sharpeRatio: 2.0, winRate: 0.7 } },
      ],
      windows: [{ id: 1 }, { id: 2 }],
    };
    mockRunWalkForward.mockResolvedValue(walkForwardResult);

    const mockTemplate = {
      _id: { toString: () => 'template123' },
      version: 3,
    };
    mockCreateTemplateVersion.mockResolvedValue(mockTemplate);
    mockMarkResultsAsContributors.mockResolvedValue(undefined);

    const response = await POST(makeRequest({
      tradingStyle: 'scalping', symbol: 'BTCUSDT', interval: '1m', months: 6,
    }));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.jobId).toBe('job123');
    expect(data.status).toBe('completed');
    expect(data.optimizedWeights).toEqual({ rsi: 0.3, macd: 0.4, volume: 0.3 });
    expect(data.templateVersion).toBe(3);
    expect(data.templateId).toBe('template123');
    expect(data.performance.avgSharpe).toBeCloseTo(1.75);
    expect(data.performance.avgWinRate).toBeCloseTo(0.65);
    expect(data.performance.totalBacktests).toBe(2);
    expect(data.windows).toBe(2);

    // Verify job was created with correct params
    expect(mockJobCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        tradingStyle: 'scalping',
        symbol: 'BTCUSDT',
        interval: '1m',
        status: 'pending',
      })
    );

    // Verify job save was called (status updates)
    expect(mockJobSave).toHaveBeenCalled();
    expect(mockMarkResultsAsContributors).toHaveBeenCalledWith(['result1', 'result2']);
  });

  it('should update job to failed status when walk-forward throws', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const candles = generateCandles(500);
    mockGetCandles.mockResolvedValue(candles);

    const mockJob = {
      _id: { toString: () => 'job123' },
      status: 'pending',
      startedAt: null,
      completedAt: null,
      optimizedWeights: null,
      ensembleResults: [],
      templateVersion: null,
      error: null,
      progress: { candidatesTested: 0, validResults: 0 },
      save: mockJobSave,
    };
    mockJobCreate.mockResolvedValue(mockJob);
    mockJobSave.mockResolvedValue(mockJob);

    mockRunWalkForward.mockRejectedValue(new Error('Walk-forward failed'));

    const response = await POST(makeRequest({
      tradingStyle: 'day_trading', symbol: 'ETHUSDT', interval: '5m', months: 3,
    }));
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Internal server error');

    // Verify job was marked as failed
    expect(mockJob.status).toBe('failed');
    expect(mockJob.error).toBe('Walk-forward failed');
  });

  it('should handle database connection errors', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockConnectDB.mockRejectedValue(new Error('Connection failed'));

    const response = await POST(makeRequest({
      tradingStyle: 'scalping', symbol: 'BTCUSDT', interval: '1m', months: 6,
    }));
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Internal server error');
  });

  it('should handle JSON parse errors', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const request = new Request('http://localhost:3000/api/admin/optimize-template', {
      method: 'POST',
      body: 'invalid json',
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Internal server error');
  });
});
