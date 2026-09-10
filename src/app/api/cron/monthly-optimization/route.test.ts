import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from './route';

// Mock dependencies
const mockConnectDB = vi.fn();
vi.mock('@/lib/mongodb', () => ({
  connectDB: () => mockConnectDB(),
}));

const mockFindOne = vi.fn();
const mockCreate = vi.fn();
const mockUpdateOne = vi.fn();

vi.mock('@/lib/models/cron-run', () => ({
  CronRun: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    create: (...args: unknown[]) => mockCreate(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));

const mockGetTopSymbols = vi.fn();
vi.mock('@/lib/optimization/top-symbols', () => ({
  getTopSymbols: (...args: unknown[]) => mockGetTopSymbols(...args),
}));

const mockRunMonthlyOptimization = vi.fn();
vi.mock('@/lib/optimization/monthly-orchestrator', () => ({
  runMonthlyOptimization: (...args: unknown[]) => mockRunMonthlyOptimization(...args),
}));

describe('POST /api/cron/monthly-optimization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockGetTopSymbols.mockResolvedValue(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT']);

    // Mock runMonthlyOptimization to return a resolved promise that we don't await
    mockRunMonthlyOptimization.mockResolvedValue({
      completedJobs: 4,
      failedJobs: 0,
      activatedTemplates: 2,
      errors: [],
    });
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it('should reject requests without authorization header', async () => {
    const request = new NextRequest('http://localhost:3000/api/cron/monthly-optimization', {
      method: 'POST',
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it('should reject requests with invalid CRON_SECRET', async () => {
    process.env.CRON_SECRET = 'valid-secret';

    const request = new NextRequest('http://localhost:3000/api/cron/monthly-optimization', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer invalid-secret',
      },
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it('should reject when CRON_SECRET is not configured', async () => {
    // CRON_SECRET not set

    const request = new NextRequest('http://localhost:3000/api/cron/monthly-optimization', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer any-token',
      },
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('should accept requests with valid CRON_SECRET', async () => {
    process.env.CRON_SECRET = 'valid-secret';
    mockFindOne.mockResolvedValue(null); // No existing running job

    const cronRunId = 'cronrun123';
    mockCreate.mockResolvedValue({
      _id: cronRunId,
      type: 'monthly_optimization',
      status: 'scheduled',
      jobs: [],
    });

    const request = new NextRequest('http://localhost:3000/api/cron/monthly-optimization', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.message).toBe('Monthly optimization started');
    expect(data.cronRunId).toBe(cronRunId);
    expect(mockConnectDB).toHaveBeenCalled();
  });

  it('should return 409 if optimization already running', async () => {
    process.env.CRON_SECRET = 'valid-secret';

    const existingRunId = 'existing123';
    mockFindOne.mockResolvedValue({
      _id: existingRunId,
      status: 'running',
    });

    const request = new NextRequest('http://localhost:3000/api/cron/monthly-optimization', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.message).toContain('already running');
    expect(data.cronRunId).toBe(existingRunId);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('should create CronRun with 4 pending jobs', async () => {
    process.env.CRON_SECRET = 'valid-secret';
    mockFindOne.mockResolvedValue(null);

    const cronRunId = 'cronrun123';
    mockCreate.mockResolvedValue({ _id: cronRunId });

    const request = new NextRequest('http://localhost:3000/api/cron/monthly-optimization', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    await POST(request);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'monthly_optimization',
        status: 'scheduled',
        jobs: [
          { tradingStyle: 'scalping', status: 'pending' },
          { tradingStyle: 'day_trading', status: 'pending' },
          { tradingStyle: 'swing_trading', status: 'pending' },
          { tradingStyle: 'position_trading', status: 'pending' },
        ],
        summary: {
          totalJobs: 4,
          completedJobs: 0,
          failedJobs: 0,
          activatedTemplates: 0,
        },
      })
    );
  });

  it('should fetch top 5 symbols', async () => {
    process.env.CRON_SECRET = 'valid-secret';
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ _id: 'cronrun123' });

    const request = new NextRequest('http://localhost:3000/api/cron/monthly-optimization', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    await POST(request);

    expect(mockGetTopSymbols).toHaveBeenCalledWith(5);
  });

  it('should return top symbols in response', async () => {
    process.env.CRON_SECRET = 'valid-secret';
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ _id: 'cronrun123' });

    const topSymbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
    mockGetTopSymbols.mockResolvedValue(topSymbols);

    const request = new NextRequest('http://localhost:3000/api/cron/monthly-optimization', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    const response = await POST(request);
    const data = await response.json();

    expect(data.topSymbols).toEqual(topSymbols);
  });

  it('should start monthly optimization in background', async () => {
    process.env.CRON_SECRET = 'valid-secret';
    mockFindOne.mockResolvedValue(null);

    const cronRunId = 'cronrun123';
    mockCreate.mockResolvedValue({ _id: cronRunId });

    const request = new NextRequest('http://localhost:3000/api/cron/monthly-optimization', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    await POST(request);

    // Should call runMonthlyOptimization but not await it. No months value is
    // passed, so the orchestrator applies each style's own window.
    expect(mockRunMonthlyOptimization).toHaveBeenCalledWith(
      expect.objectContaining({
        cronRunId,
        topSymbols: expect.any(Array),
        autoActivate: false,
      })
    );
    expect(mockRunMonthlyOptimization.mock.calls[0][0]).not.toHaveProperty('months');
  });

  it('does not auto-activate templates unless OPTIMIZATION_AUTO_ACTIVATE is set', async () => {
    process.env.CRON_SECRET = 'valid-secret';
    delete process.env.OPTIMIZATION_AUTO_ACTIVATE;
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ _id: 'cronrun123' });

    await POST(
      new NextRequest('http://localhost:3000/api/cron/monthly-optimization', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-secret' },
      })
    );

    expect(mockRunMonthlyOptimization).toHaveBeenCalledWith(
      expect.objectContaining({ autoActivate: false })
    );
  });

  it('auto-activates when OPTIMIZATION_AUTO_ACTIVATE is exactly "true"', async () => {
    process.env.CRON_SECRET = 'valid-secret';
    process.env.OPTIMIZATION_AUTO_ACTIVATE = 'true';
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ _id: 'cronrun123' });

    await POST(
      new NextRequest('http://localhost:3000/api/cron/monthly-optimization', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-secret' },
      })
    );

    expect(mockRunMonthlyOptimization).toHaveBeenCalledWith(
      expect.objectContaining({ autoActivate: true })
    );

    delete process.env.OPTIMIZATION_AUTO_ACTIVATE;
  });

  it('should handle database connection errors', async () => {
    process.env.CRON_SECRET = 'valid-secret';
    mockConnectDB.mockRejectedValue(new Error('Connection failed'));

    const request = new NextRequest('http://localhost:3000/api/cron/monthly-optimization', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Internal server error');
  });

  it('should handle CronRun creation errors', async () => {
    process.env.CRON_SECRET = 'valid-secret';
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockRejectedValue(new Error('Database error'));

    const request = new NextRequest('http://localhost:3000/api/cron/monthly-optimization', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Internal server error');
  });
});
