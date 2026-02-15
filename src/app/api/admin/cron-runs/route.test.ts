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

vi.mock('@/lib/models/cron-run', () => ({
  CronRun: {
    find: () => mockFind(),
  },
}));

describe('GET /api/admin/cron-runs', () => {
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
    mockAuth.mockResolvedValue({
      user: { email: 'user@example.com' },
    });

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it('should return empty array when no cron runs', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockLean.mockResolvedValue([]);

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual([]);
  });

  it('should return cron runs sorted by scheduledAt desc', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const mockRuns = [
      {
        _id: 'id1',
        type: 'monthly_optimization',
        scheduledAt: new Date('2025-02-01'),
        startedAt: new Date('2025-02-01'),
        completedAt: new Date('2025-02-01'),
        status: 'completed',
        jobs: [],
        summary: { totalJobs: 4, completedJobs: 4, failedJobs: 0, activatedTemplates: 2 },
        error: null,
        createdAt: new Date('2025-02-01'),
      },
    ];
    mockLean.mockResolvedValue(mockRuns);

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(mockSort).toHaveBeenCalledWith({ scheduledAt: -1 });
  });

  it('should transform _id to id string', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const mockRuns = [
      {
        _id: 'abc123',
        type: 'monthly_optimization',
        scheduledAt: new Date('2025-02-01'),
        startedAt: null,
        completedAt: null,
        status: 'scheduled',
        jobs: [],
        summary: { totalJobs: 0, completedJobs: 0, failedJobs: 0, activatedTemplates: 0 },
        error: null,
        createdAt: new Date('2025-02-01'),
      },
    ];
    mockLean.mockResolvedValue(mockRuns);

    const response = await GET();
    const data = await response.json();

    expect(data[0].id).toBe('abc123');
    expect(data[0]._id).toBeUndefined();
  });

  it('should include jobs array and summary in response', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const jobs = [
      {
        tradingStyle: 'scalping',
        symbol: 'BTCUSDT',
        interval: '1m',
        jobId: null,
        status: 'completed',
        startedAt: null,
        completedAt: null,
        error: null,
        activated: true,
        activationReason: 'Improved performance',
      },
    ];
    const summary = { totalJobs: 1, completedJobs: 1, failedJobs: 0, activatedTemplates: 1 };

    mockLean.mockResolvedValue([
      {
        _id: 'id1',
        type: 'monthly_optimization',
        scheduledAt: new Date('2025-02-01'),
        startedAt: new Date('2025-02-01'),
        completedAt: new Date('2025-02-01'),
        status: 'completed',
        jobs,
        summary,
        error: null,
        createdAt: new Date('2025-02-01'),
      },
    ]);

    const response = await GET();
    const data = await response.json();

    expect(data[0].jobs).toEqual(jobs);
    expect(data[0].summary).toEqual(summary);
  });

  it('should limit to 50 results', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockLean.mockResolvedValue([]);

    await GET();

    expect(mockLimit).toHaveBeenCalledWith(50);
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
});
