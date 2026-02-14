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
vi.mock('@/lib/models/cron-run', () => ({
  CronRun: {
    findById: (...args: unknown[]) => mockFindById(...args),
  },
}));

describe('GET /api/cron/monthly-optimization/[cronRunId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.ADMIN_EMAIL;
  });

  it('should allow access with valid CRON_SECRET', async () => {
    process.env.CRON_SECRET = 'valid-secret';

    const cronRun = {
      _id: 'cronrun123',
      status: 'completed',
      startedAt: new Date(),
      jobs: [
        { status: 'completed' },
        { status: 'completed' },
        { status: 'failed' },
        { status: 'pending' },
      ],
      summary: {
        activatedTemplates: 2,
      },
    };
    mockFindById.mockResolvedValue(cronRun);

    const request = new Request('http://localhost:3000/api/cron/monthly-optimization/cronrun123', {
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    const params = Promise.resolve({ cronRunId: 'cronrun123' });
    const response = await GET(request, { params });

    expect(response.status).toBe(200);
    expect(mockAuth).not.toHaveBeenCalled(); // CRON_SECRET bypasses auth
  });

  it('should allow access for admin users when no CRON_SECRET', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';

    mockAuth.mockResolvedValue({
      user: { email: 'admin@example.com' },
    });

    const cronRun = {
      _id: 'cronrun123',
      status: 'running',
      jobs: [],
      summary: { activatedTemplates: 0 },
    };
    mockFindById.mockResolvedValue(cronRun);

    const request = new Request('http://localhost:3000/api/cron/monthly-optimization/cronrun123');

    const params = Promise.resolve({ cronRunId: 'cronrun123' });
    const response = await GET(request, { params });

    expect(response.status).toBe(200);
    expect(mockAuth).toHaveBeenCalled();
  });

  it('should reject non-admin users without CRON_SECRET', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';

    mockAuth.mockResolvedValue({
      user: { email: 'user@example.com' },
    });

    const request = new Request('http://localhost:3000/api/cron/monthly-optimization/cronrun123');

    const params = Promise.resolve({ cronRunId: 'cronrun123' });
    const response = await GET(request, { params });
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it('should reject unauthenticated users', async () => {
    mockAuth.mockResolvedValue(null);

    const request = new Request('http://localhost:3000/api/cron/monthly-optimization/cronrun123');

    const params = Promise.resolve({ cronRunId: 'cronrun123' });
    const response = await GET(request, { params });
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('should return 404 for non-existent cronRunId', async () => {
    process.env.CRON_SECRET = 'valid-secret';
    mockFindById.mockResolvedValue(null);

    const request = new Request('http://localhost:3000/api/cron/monthly-optimization/invalid123', {
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    const params = Promise.resolve({ cronRunId: 'invalid123' });
    const response = await GET(request, { params });
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe('Cron run not found');
  });

  it('should return cron run details', async () => {
    process.env.CRON_SECRET = 'valid-secret';

    const cronRun = {
      _id: 'cronrun123',
      type: 'monthly_optimization',
      status: 'running',
      startedAt: new Date(),
      jobs: [
        { status: 'completed' },
        { status: 'running' },
        { status: 'pending' },
        { status: 'pending' },
      ],
      summary: {
        activatedTemplates: 1,
      },
    };
    mockFindById.mockResolvedValue(cronRun);

    const request = new Request('http://localhost:3000/api/cron/monthly-optimization/cronrun123', {
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    const params = Promise.resolve({ cronRunId: 'cronrun123' });
    const response = await GET(request, { params });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.job).toBeDefined();
    expect(data.job._id).toBe('cronrun123');
  });

  it('should calculate progress percentage correctly', async () => {
    process.env.CRON_SECRET = 'valid-secret';

    const cronRun = {
      _id: 'cronrun123',
      status: 'running',
      startedAt: new Date(),
      jobs: [
        { status: 'completed' },
        { status: 'completed' },
        { status: 'running' },
        { status: 'pending' },
      ],
      summary: {
        activatedTemplates: 2,
      },
    };
    mockFindById.mockResolvedValue(cronRun);

    const request = new Request('http://localhost:3000/api/cron/monthly-optimization/cronrun123', {
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    const params = Promise.resolve({ cronRunId: 'cronrun123' });
    const response = await GET(request, { params });
    const data = await response.json();

    expect(data.progress.percent).toBe(50); // 2 completed out of 4 = 50%
    expect(data.progress.totalJobs).toBe(4);
    expect(data.progress.completedJobs).toBe(2);
    expect(data.progress.failedJobs).toBe(0);
  });

  it('should count failed jobs in progress', async () => {
    process.env.CRON_SECRET = 'valid-secret';

    const cronRun = {
      _id: 'cronrun123',
      status: 'running',
      startedAt: new Date(),
      jobs: [
        { status: 'completed' },
        { status: 'failed' },
        { status: 'running' },
        { status: 'pending' },
      ],
      summary: {
        activatedTemplates: 1,
      },
    };
    mockFindById.mockResolvedValue(cronRun);

    const request = new Request('http://localhost:3000/api/cron/monthly-optimization/cronrun123', {
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    const params = Promise.resolve({ cronRunId: 'cronrun123' });
    const response = await GET(request, { params });
    const data = await response.json();

    expect(data.progress.percent).toBe(50); // 2 finished (1 completed + 1 failed) out of 4
    expect(data.progress.completedJobs).toBe(1);
    expect(data.progress.failedJobs).toBe(1);
  });

  it('should calculate current job number correctly', async () => {
    process.env.CRON_SECRET = 'valid-secret';

    const cronRun = {
      _id: 'cronrun123',
      status: 'running',
      startedAt: new Date(),
      jobs: [
        { status: 'completed' },
        { status: 'completed' },
        { status: 'failed' },
        { status: 'pending' },
      ],
      summary: {
        activatedTemplates: 2,
      },
    };
    mockFindById.mockResolvedValue(cronRun);

    const request = new Request('http://localhost:3000/api/cron/monthly-optimization/cronrun123', {
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    const params = Promise.resolve({ cronRunId: 'cronrun123' });
    const response = await GET(request, { params });
    const data = await response.json();

    expect(data.progress.currentJob).toBe(4); // finishedJobs (3) + 1
  });

  it('should include activated templates count', async () => {
    process.env.CRON_SECRET = 'valid-secret';

    const cronRun = {
      _id: 'cronrun123',
      status: 'completed',
      startedAt: new Date(),
      jobs: Array(4).fill({ status: 'completed' }),
      summary: {
        activatedTemplates: 3,
      },
    };
    mockFindById.mockResolvedValue(cronRun);

    const request = new Request('http://localhost:3000/api/cron/monthly-optimization/cronrun123', {
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    const params = Promise.resolve({ cronRunId: 'cronrun123' });
    const response = await GET(request, { params });
    const data = await response.json();

    expect(data.progress.activatedTemplates).toBe(3);
  });

  it('should estimate time remaining for running jobs', async () => {
    process.env.CRON_SECRET = 'valid-secret';

    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
    const cronRun = {
      _id: 'cronrun123',
      status: 'running',
      startedAt: twoMinutesAgo,
      jobs: [
        { status: 'completed' },
        { status: 'running' },
        { status: 'pending' },
        { status: 'pending' },
      ],
      summary: {
        activatedTemplates: 1,
      },
    };
    mockFindById.mockResolvedValue(cronRun);

    const request = new Request('http://localhost:3000/api/cron/monthly-optimization/cronrun123', {
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    const params = Promise.resolve({ cronRunId: 'cronrun123' });
    const response = await GET(request, { params });
    const data = await response.json();

    // 1 completed in 2 minutes = 2 min/job
    // 3 remaining jobs = 6 minutes
    expect(data.progress.estimatedTimeRemaining).toBeGreaterThan(0);
    expect(data.progress.estimatedTimeRemaining).toBeLessThan(600); // Less than 10 minutes
  });

  it('should return 0 ETA when status is not running', async () => {
    process.env.CRON_SECRET = 'valid-secret';

    const cronRun = {
      _id: 'cronrun123',
      status: 'completed',
      startedAt: new Date(),
      jobs: Array(4).fill({ status: 'completed' }),
      summary: {
        activatedTemplates: 2,
      },
    };
    mockFindById.mockResolvedValue(cronRun);

    const request = new Request('http://localhost:3000/api/cron/monthly-optimization/cronrun123', {
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    const params = Promise.resolve({ cronRunId: 'cronrun123' });
    const response = await GET(request, { params });
    const data = await response.json();

    expect(data.progress.estimatedTimeRemaining).toBe(0);
  });

  it('should handle database errors', async () => {
    process.env.CRON_SECRET = 'valid-secret';
    mockFindById.mockRejectedValue(new Error('Database error'));

    const request = new Request('http://localhost:3000/api/cron/monthly-optimization/cronrun123', {
      headers: {
        Authorization: 'Bearer valid-secret',
      },
    });

    const params = Promise.resolve({ cronRunId: 'cronrun123' });
    const response = await GET(request, { params });
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toContain('Database error');
  });
});
