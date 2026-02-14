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

const mockFindOne = vi.fn();
const mockCreate = vi.fn();

vi.mock('@/lib/models/cron-run', () => ({
  CronRun: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    create: (...args: unknown[]) => mockCreate(...args),
  },
}));

const mockGetTopSymbols = vi.fn();
vi.mock('@/lib/optimization/top-symbols', () => ({
  getTopSymbols: (...args: unknown[]) => mockGetTopSymbols(...args),
  FALLBACK_SYMBOLS: ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT'],
}));

const mockRunMonthlyOptimization = vi.fn();
vi.mock('@/lib/optimization/monthly-orchestrator', () => ({
  runMonthlyOptimization: (...args: unknown[]) => mockRunMonthlyOptimization(...args),
}));

describe('POST /api/admin/trigger-monthly-optimization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
    mockGetTopSymbols.mockResolvedValue(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT']);
    mockRunMonthlyOptimization.mockResolvedValue({
      completedJobs: 4,
      failedJobs: 0,
      activatedTemplates: 2,
      errors: [],
    });
  });

  afterEach(() => {
    delete process.env.ADMIN_EMAIL;
  });

  it('should reject non-admin users', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';

    mockAuth.mockResolvedValue({
      user: { email: 'user@example.com' },
    });

    const request = new Request('http://localhost:3000/api/admin/trigger-monthly-optimization', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it('should reject unauthenticated users', async () => {
    mockAuth.mockResolvedValue(null);

    const request = new Request('http://localhost:3000/api/admin/trigger-monthly-optimization', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
  });

  it('should allow admin users', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';

    mockAuth.mockResolvedValue({
      user: { email: 'admin@example.com' },
    });

    mockFindOne.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ _id: 'cronrun123' });

    const request = new Request('http://localhost:3000/api/admin/trigger-monthly-optimization', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mockConnectDB).toHaveBeenCalled();
  });

  it('should validate request body with invalid symbols', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const request = new Request('http://localhost:3000/api/admin/trigger-monthly-optimization', {
      method: 'POST',
      body: JSON.stringify({
        symbols: ['BTCUSDT', 123], // Invalid: number instead of string
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid request');
    expect(data.issues).toBeDefined();
  });

  it('should validate months range (1-12)', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const request = new Request('http://localhost:3000/api/admin/trigger-monthly-optimization', {
      method: 'POST',
      body: JSON.stringify({
        months: 15, // Invalid: > 12
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid request');
  });

  it('should validate symbols array length (1-10)', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const request = new Request('http://localhost:3000/api/admin/trigger-monthly-optimization', {
      method: 'POST',
      body: JSON.stringify({
        symbols: [], // Invalid: empty array
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid request');
  });

  it('should accept valid request with no overrides', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockFindOne.mockResolvedValue(null);

    const cronRunId = 'cronrun123';
    mockCreate.mockResolvedValue({ _id: cronRunId });

    const request = new Request('http://localhost:3000/api/admin/trigger-monthly-optimization', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.message).toBe('Monthly optimization started');
    expect(data.cronRunId).toBe(cronRunId);
  });

  it('should accept optional symbols override', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ _id: 'cronrun123' });

    const customSymbols = ['BTCUSDT', 'ETHUSDT'];
    const request = new Request('http://localhost:3000/api/admin/trigger-monthly-optimization', {
      method: 'POST',
      body: JSON.stringify({
        symbols: customSymbols,
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.config.symbols).toEqual(customSymbols);
    expect(mockGetTopSymbols).not.toHaveBeenCalled(); // Should not fetch if provided
  });

  it('should accept optional months override', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ _id: 'cronrun123' });

    const request = new Request('http://localhost:3000/api/admin/trigger-monthly-optimization', {
      method: 'POST',
      body: JSON.stringify({
        months: 3,
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.config.months).toBe(3);

    expect(mockRunMonthlyOptimization).toHaveBeenCalledWith(
      expect.objectContaining({
        months: 3,
      })
    );
  });

  it('should accept optional autoActivate override', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ _id: 'cronrun123' });

    const request = new Request('http://localhost:3000/api/admin/trigger-monthly-optimization', {
      method: 'POST',
      body: JSON.stringify({
        autoActivate: false,
      }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.config.autoActivate).toBe(false);

    expect(mockRunMonthlyOptimization).toHaveBeenCalledWith(
      expect.objectContaining({
        autoActivate: false,
      })
    );
  });

  it('should return 409 if optimization already running', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const existingRunId = 'existing123';
    mockFindOne.mockResolvedValue({
      _id: existingRunId,
      status: 'running',
    });

    const request = new Request('http://localhost:3000/api/admin/trigger-monthly-optimization', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.error).toContain('already running');
    expect(data.cronRunId).toBe(existingRunId);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('should create CronRun with 4 pending jobs', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ _id: 'cronrun123' });

    const request = new Request('http://localhost:3000/api/admin/trigger-monthly-optimization', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    await POST(request);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'monthly_optimization',
        status: 'scheduled',
        jobs: expect.arrayContaining([
          expect.objectContaining({ tradingStyle: 'scalping', status: 'pending' }),
          expect.objectContaining({ tradingStyle: 'day_trading', status: 'pending' }),
          expect.objectContaining({ tradingStyle: 'swing_trading', status: 'pending' }),
          expect.objectContaining({ tradingStyle: 'position_trading', status: 'pending' }),
        ]),
      })
    );
  });

  it('should fetch top symbols when not provided', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockFindOne.mockResolvedValue(null);
    mockCreate.mockResolvedValue({ _id: 'cronrun123' });

    const request = new Request('http://localhost:3000/api/admin/trigger-monthly-optimization', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    await POST(request);

    expect(mockGetTopSymbols).toHaveBeenCalledWith(5);
  });

  it('should start monthly optimization in background', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockFindOne.mockResolvedValue(null);

    const cronRunId = 'cronrun123';
    mockCreate.mockResolvedValue({ _id: cronRunId });

    const request = new Request('http://localhost:3000/api/admin/trigger-monthly-optimization', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    await POST(request);

    expect(mockRunMonthlyOptimization).toHaveBeenCalledWith(
      expect.objectContaining({
        cronRunId,
        topSymbols: expect.any(Array),
        months: 6,
        autoActivate: true,
      })
    );
  });

  it('should handle JSON parse errors', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const request = new Request('http://localhost:3000/api/admin/trigger-monthly-optimization', {
      method: 'POST',
      body: 'invalid json',
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBeDefined();
  });

  it('should handle database errors', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockConnectDB.mockRejectedValue(new Error('Connection failed'));

    const request = new Request('http://localhost:3000/api/admin/trigger-monthly-optimization', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toContain('Connection failed');
  });
});
