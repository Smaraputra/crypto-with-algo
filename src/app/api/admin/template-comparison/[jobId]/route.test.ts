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

const mockJobFindById = vi.fn();
vi.mock('@/lib/models/optimization-job', () => ({
  OptimizationJob: {
    findById: (...args: unknown[]) => mockJobFindById(...args),
  },
}));

const mockTemplateFindOne = vi.fn();
vi.mock('@/lib/models/signal-template', () => ({
  SignalTemplate: {
    findOne: (...args: unknown[]) => mockTemplateFindOne(...args),
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

describe('GET /api/admin/template-comparison/[jobId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.ADMIN_EMAIL;
  });

  function callGET(jobId: string) {
    const request = new Request(`http://localhost:3000/api/admin/template-comparison/${jobId}`);
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

  it('should reject users without email', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: {} });

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
    mockJobFindById.mockResolvedValue(null);

    const response = await callGET('507f1f77bcf86cd799439011');
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe('Job not found');
  });

  it('should return 400 when job not completed', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    mockJobFindById.mockResolvedValue({
      status: 'running',
      templateVersion: null,
      tradingStyle: 'scalping',
    });

    const response = await callGET('507f1f77bcf86cd799439011');
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Job not completed or no template created');
  });

  it('should return 400 when job has no template version', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    mockJobFindById.mockResolvedValue({
      status: 'completed',
      templateVersion: null,
      tradingStyle: 'scalping',
    });

    const response = await callGET('507f1f77bcf86cd799439011');
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Job not completed or no template created');
  });

  it('should return 404 when optimized template not found', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    mockJobFindById.mockResolvedValue({
      status: 'completed',
      templateVersion: 3,
      tradingStyle: 'scalping',
    });

    // First findOne call (optimized template) returns null
    mockTemplateFindOne.mockResolvedValueOnce(null);

    const response = await callGET('507f1f77bcf86cd799439011');
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe('Optimized template not found');
  });

  it('should return comparison with both current and optimized templates', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    mockJobFindById.mockResolvedValue({
      status: 'completed',
      templateVersion: 3,
      tradingStyle: 'scalping',
    });

    const optimizedTemplate = {
      _id: { toString: () => 'opt-template-id' },
      tradingStyle: 'scalping',
      version: 3,
      weights: { rsi: 0.4, macd: 0.3, volume: 0.3 },
      thresholds: { buyThreshold: 0.6, sellThreshold: -0.6 },
      performanceMetrics: { avgSharpe: 2.0, avgWinRate: 0.7 },
      active: false,
    };

    const currentTemplate = {
      _id: { toString: () => 'curr-template-id' },
      tradingStyle: 'scalping',
      version: 2,
      weights: { rsi: 0.5, macd: 0.3, volume: 0.2 },
      thresholds: { buyThreshold: 0.5, sellThreshold: -0.5 },
      performanceMetrics: { avgSharpe: 1.5, avgWinRate: 0.6 },
      active: true,
    };

    // First call: find optimized template by style + version
    // Second call: find current active template by style + active
    mockTemplateFindOne
      .mockResolvedValueOnce(optimizedTemplate)
      .mockResolvedValueOnce(currentTemplate);

    const response = await callGET('507f1f77bcf86cd799439011');
    const data = await response.json();

    expect(response.status).toBe(200);

    expect(data.optimizedTemplate).toBeDefined();
    expect(data.optimizedTemplate.id).toBe('opt-template-id');
    expect(data.optimizedTemplate.version).toBe(3);
    expect(data.optimizedTemplate.active).toBe(false);

    expect(data.currentTemplate).toBeDefined();
    expect(data.currentTemplate.id).toBe('curr-template-id');
    expect(data.currentTemplate.version).toBe(2);
    expect(data.currentTemplate.active).toBe(true);

    // Verify the correct queries
    expect(mockTemplateFindOne).toHaveBeenCalledWith({
      tradingStyle: 'scalping',
      version: 3,
    });
    expect(mockTemplateFindOne).toHaveBeenCalledWith({
      tradingStyle: 'scalping',
      active: true,
    });
  });

  it('should return null currentTemplate when no active template exists', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    mockJobFindById.mockResolvedValue({
      status: 'completed',
      templateVersion: 1,
      tradingStyle: 'position_trading',
    });

    const optimizedTemplate = {
      _id: { toString: () => 'opt-template-id' },
      tradingStyle: 'position_trading',
      version: 1,
      weights: { rsi: 0.3, macd: 0.7 },
      thresholds: { buyThreshold: 0.3, sellThreshold: -0.3 },
      performanceMetrics: { avgSharpe: 1.2, avgWinRate: 0.55 },
      active: false,
    };

    // First call: optimized template found
    // Second call: no active template
    mockTemplateFindOne
      .mockResolvedValueOnce(optimizedTemplate)
      .mockResolvedValueOnce(null);

    const response = await callGET('507f1f77bcf86cd799439011');
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.optimizedTemplate).toBeDefined();
    expect(data.currentTemplate).toBeNull();
  });

  it('should include all expected fields in template response', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    mockJobFindById.mockResolvedValue({
      status: 'completed',
      templateVersion: 2,
      tradingStyle: 'day_trading',
    });

    const weights = { rsi: 0.2, macd: 0.3, bollinger: 0.2, volume: 0.3 };
    const thresholds = { buyThreshold: 0.5, sellThreshold: -0.5 };
    const performanceMetrics = { avgSharpe: 1.8, avgWinRate: 0.65, totalBacktests: 10 };

    const optimizedTemplate = {
      _id: { toString: () => 'tmpl1' },
      tradingStyle: 'day_trading',
      version: 2,
      weights,
      thresholds,
      performanceMetrics,
      active: false,
    };

    mockTemplateFindOne
      .mockResolvedValueOnce(optimizedTemplate)
      .mockResolvedValueOnce(null);

    const response = await callGET('507f1f77bcf86cd799439011');
    const data = await response.json();

    const tmpl = data.optimizedTemplate;
    expect(tmpl.id).toBe('tmpl1');
    expect(tmpl.tradingStyle).toBe('day_trading');
    expect(tmpl.version).toBe(2);
    expect(tmpl.weights).toEqual(weights);
    expect(tmpl.thresholds).toEqual(thresholds);
    expect(tmpl.performanceMetrics).toEqual(performanceMetrics);
    expect(tmpl.active).toBe(false);
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

  it('should handle query errors', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });
    mockJobFindById.mockRejectedValue(new Error('Query failed'));

    const response = await callGET('507f1f77bcf86cd799439011');
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Internal server error');
  });
});
