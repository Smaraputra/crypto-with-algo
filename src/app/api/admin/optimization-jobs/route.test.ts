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

const mockLean = vi.fn();
const mockLimit = vi.fn(() => ({ lean: mockLean }));
const mockSort = vi.fn(() => ({ limit: mockLimit }));
const mockFind = vi.fn(() => ({ sort: mockSort }));

vi.mock('@/lib/models/optimization-job', () => ({
  OptimizationJob: {
    find: () => mockFind(),
  },
}));

describe('GET /api/admin/optimization-jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.ADMIN_EMAIL;
  });

  it('should reject unauthenticated users', async () => {
    mockAuth.mockResolvedValue(null);

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it('should reject non-admin users', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'user@example.com' } });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it('should reject users without email', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: {} });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('should return empty array when no jobs exist', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockLean.mockResolvedValue([]);

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual([]);
  });

  it('should return jobs sorted by createdAt desc', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const mockJobs = [
      {
        _id: { toString: () => 'job1' },
        tradingStyle: 'scalping',
        symbol: 'BTCUSDT',
        interval: '1m',
        status: 'completed',
        templateVersion: 2,
        startedAt: new Date('2025-01-15'),
        completedAt: new Date('2025-01-15'),
        createdAt: new Date('2025-01-15'),
        progress: { candidatesTested: 100, validResults: 50 },
      },
    ];
    mockLean.mockResolvedValue(mockJobs);

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(mockSort).toHaveBeenCalledWith({ createdAt: -1 });
  });

  it('should limit to 100 results', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockLean.mockResolvedValue([]);

    await GET();

    expect(mockLimit).toHaveBeenCalledWith(100);
  });

  it('should transform _id to id string', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    mockLean.mockResolvedValue([
      {
        _id: { toString: () => 'abc123' },
        tradingStyle: 'day_trading',
        symbol: 'ETHUSDT',
        interval: '5m',
        status: 'running',
        templateVersion: null,
        startedAt: new Date('2025-02-01'),
        completedAt: null,
        createdAt: new Date('2025-02-01'),
        progress: { candidatesTested: 25, validResults: 10 },
      },
    ]);

    const response = await GET();
    const data = await response.json();

    expect(data[0].id).toBe('abc123');
    expect(data[0]._id).toBeUndefined();
  });

  it('should include progress data in response', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    mockLean.mockResolvedValue([
      {
        _id: { toString: () => 'job1' },
        tradingStyle: 'swing_trading',
        symbol: 'SOLUSDT',
        interval: '4h',
        status: 'completed',
        templateVersion: 3,
        startedAt: new Date('2025-01-10'),
        completedAt: new Date('2025-01-10'),
        createdAt: new Date('2025-01-10'),
        progress: { candidatesTested: 200, validResults: 80 },
      },
    ]);

    const response = await GET();
    const data = await response.json();

    expect(data[0].progress).toEqual({
      candidatesTested: 200,
      validResults: 80,
    });
  });

  it('should include all expected fields in response', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const startedAt = new Date('2025-01-15T10:00:00Z');
    const completedAt = new Date('2025-01-15T11:00:00Z');
    const createdAt = new Date('2025-01-15T09:00:00Z');

    mockLean.mockResolvedValue([
      {
        _id: { toString: () => 'job1' },
        tradingStyle: 'position_trading',
        symbol: 'BNBUSDT',
        interval: '1d',
        status: 'completed',
        templateVersion: 5,
        startedAt,
        completedAt,
        createdAt,
        progress: { candidatesTested: 300, validResults: 120 },
      },
    ]);

    const response = await GET();
    const data = await response.json();

    const job = data[0];
    expect(job.id).toBe('job1');
    expect(job.tradingStyle).toBe('position_trading');
    expect(job.symbol).toBe('BNBUSDT');
    expect(job.interval).toBe('1d');
    expect(job.status).toBe('completed');
    expect(job.templateVersion).toBe(5);
    expect(job.startedAt).toBeDefined();
    expect(job.completedAt).toBeDefined();
    expect(job.createdAt).toBeDefined();
  });

  it('should handle database errors', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockConnectDB.mockRejectedValue(new Error('Connection failed'));

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Internal server error');
  });

  it('should handle query errors', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockLean.mockRejectedValue(new Error('Query failed'));

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Internal server error');
  });
});
