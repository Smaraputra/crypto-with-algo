import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GET } from './route';

// Mock dependencies
const mockConnectDB = vi.fn();
vi.mock('@/lib/mongodb', () => ({
  connectDB: () => mockConnectDB(),
}));

const mockAuth = vi.fn();
vi.mock('@/lib/auth', () => ({
  auth: () => mockAuth(),
}));

const mockFindById = vi.fn();
vi.mock('@/lib/models/optimization-job', () => ({
  OptimizationJob: {
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}));

// mongoose.Types.ObjectId.isValid needs to work
vi.mock('mongoose', async () => {
  const actual = await vi.importActual<typeof import('mongoose')>('mongoose');
  return {
    ...actual,
    default: actual.default,
  };
});

describe('GET /api/admin/optimize-template/[jobId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.ADMIN_EMAIL;
  });

  function callGET(jobId: string) {
    const request = new Request(`http://localhost:3000/api/admin/optimize-template/${jobId}`);
    return GET(request, { params: Promise.resolve({ jobId }) });
  }

  it('should reject unauthenticated users', async () => {
    mockAuth.mockResolvedValue(null);

    const response = await callGET('507f1f77bcf86cd799439011');
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it('should reject non-admin users', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'user@example.com' } });

    const response = await callGET('507f1f77bcf86cd799439011');
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('should reject invalid ObjectId', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const response = await callGET('not-a-valid-id');
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid job ID');
  });

  it('should return 404 when job not found', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockFindById.mockResolvedValue(null);

    const response = await callGET('507f1f77bcf86cd799439011');
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe('Job not found');
  });

  it('should return job status for a pending job', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const jobId = '507f1f77bcf86cd799439011';
    mockFindById.mockResolvedValue({
      _id: { toString: () => jobId },
      tradingStyle: 'scalping',
      symbol: 'BTCUSDT',
      interval: '1m',
      status: 'pending',
      error: null,
      optimizedWeights: null,
      templateVersion: null,
      startedAt: null,
      completedAt: null,
      createdAt: new Date('2025-01-15'),
      progress: {
        currentWindow: 0,
        totalWindows: 0,
        candidatesTested: 0,
        validResults: 0,
      },
    });

    const response = await callGET(jobId);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.job.id).toBe(jobId);
    expect(data.job.status).toBe('pending');
    expect(data.progress.percent).toBe(0);
    expect(data.progress.estimatedTimeRemaining).toBe(0);
  });

  it('should calculate progress percentage for running job', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const jobId = '507f1f77bcf86cd799439011';
    const startedAt = new Date(Date.now() - 60000); // Started 60 seconds ago
    mockFindById.mockResolvedValue({
      _id: { toString: () => jobId },
      tradingStyle: 'day_trading',
      symbol: 'ETHUSDT',
      interval: '5m',
      status: 'running',
      error: null,
      optimizedWeights: null,
      templateVersion: null,
      startedAt,
      completedAt: null,
      createdAt: new Date('2025-01-15'),
      progress: {
        currentWindow: 3,
        totalWindows: 10,
        candidatesTested: 150,
        validResults: 60,
      },
    });

    const response = await callGET(jobId);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.job.status).toBe('running');
    expect(data.progress.percent).toBe(30); // 3/10 = 30%
    expect(data.progress.currentWindow).toBe(3);
    expect(data.progress.totalWindows).toBe(10);
    expect(data.progress.candidatesTested).toBe(150);
    expect(data.progress.validResults).toBe(60);
    expect(data.progress.estimatedTimeRemaining).toBeGreaterThan(0);
  });

  it('should return completed job with optimized weights', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const jobId = '507f1f77bcf86cd799439011';
    mockFindById.mockResolvedValue({
      _id: { toString: () => jobId },
      tradingStyle: 'swing_trading',
      symbol: 'SOLUSDT',
      interval: '4h',
      status: 'completed',
      error: null,
      optimizedWeights: { rsi: 0.3, macd: 0.4, volume: 0.3 },
      templateVersion: 5,
      startedAt: new Date('2025-01-15T10:00:00Z'),
      completedAt: new Date('2025-01-15T11:00:00Z'),
      createdAt: new Date('2025-01-15T09:00:00Z'),
      progress: {
        currentWindow: 10,
        totalWindows: 10,
        candidatesTested: 500,
        validResults: 200,
      },
    });

    const response = await callGET(jobId);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.job.status).toBe('completed');
    expect(data.job.optimizedWeights).toEqual({ rsi: 0.3, macd: 0.4, volume: 0.3 });
    expect(data.job.templateVersion).toBe(5);
    expect(data.progress.percent).toBe(100);
  });

  it('should return failed job with error message', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const jobId = '507f1f77bcf86cd799439011';
    mockFindById.mockResolvedValue({
      _id: { toString: () => jobId },
      tradingStyle: 'position_trading',
      symbol: 'BNBUSDT',
      interval: '1d',
      status: 'failed',
      error: 'Walk-forward optimization failed',
      optimizedWeights: null,
      templateVersion: null,
      startedAt: new Date('2025-01-15T10:00:00Z'),
      completedAt: new Date('2025-01-15T10:05:00Z'),
      createdAt: new Date('2025-01-15T09:00:00Z'),
      progress: {
        currentWindow: 2,
        totalWindows: 10,
        candidatesTested: 50,
        validResults: 10,
      },
    });

    const response = await callGET(jobId);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.job.status).toBe('failed');
    expect(data.job.error).toBe('Walk-forward optimization failed');
  });

  it('should handle zero progress for time estimation', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const jobId = '507f1f77bcf86cd799439011';
    mockFindById.mockResolvedValue({
      _id: { toString: () => jobId },
      tradingStyle: 'scalping',
      symbol: 'BTCUSDT',
      interval: '1m',
      status: 'running',
      error: null,
      optimizedWeights: null,
      templateVersion: null,
      startedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
      progress: {
        currentWindow: 0,
        totalWindows: 10,
        candidatesTested: 0,
        validResults: 0,
      },
    });

    const response = await callGET(jobId);
    const data = await response.json();

    expect(response.status).toBe(200);
    // When currentWindow is 0, estimatedTimeRemaining should be 0
    expect(data.progress.estimatedTimeRemaining).toBe(0);
  });

  it('should handle database errors', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockConnectDB.mockRejectedValue(new Error('Connection failed'));

    const response = await callGET('507f1f77bcf86cd799439011');
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Internal server error');
  });
});
