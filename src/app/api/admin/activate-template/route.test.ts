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

const mockActivateTemplate = vi.fn();
vi.mock('@/lib/optimization/template-versioning', () => ({
  activateTemplate: (...args: unknown[]) => mockActivateTemplate(...args),
}));

// mongoose.Types.ObjectId.isValid needs to work, so we partially mock
vi.mock('mongoose', async () => {
  const actual = await vi.importActual<typeof import('mongoose')>('mongoose');
  return {
    ...actual,
    default: actual.default,
  };
});

describe('POST /api/admin/activate-template', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnectDB.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.ADMIN_EMAIL;
  });

  it('should reject unauthenticated users', async () => {
    mockAuth.mockResolvedValue(null);

    const request = new Request('http://localhost:3000/api/admin/activate-template', {
      method: 'POST',
      body: JSON.stringify({ templateId: '507f1f77bcf86cd799439011' }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it('should reject non-admin users', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'user@example.com' } });

    const request = new Request('http://localhost:3000/api/admin/activate-template', {
      method: 'POST',
      body: JSON.stringify({ templateId: '507f1f77bcf86cd799439011' }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toBe('Unauthorized');
    expect(mockConnectDB).not.toHaveBeenCalled();
  });

  it('should reject request with missing templateId', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const request = new Request('http://localhost:3000/api/admin/activate-template', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid request');
    expect(data.issues).toBeDefined();
  });

  it('should reject request with empty templateId', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const request = new Request('http://localhost:3000/api/admin/activate-template', {
      method: 'POST',
      body: JSON.stringify({ templateId: '' }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid request');
  });

  it('should reject invalid ObjectId', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const request = new Request('http://localhost:3000/api/admin/activate-template', {
      method: 'POST',
      body: JSON.stringify({ templateId: 'not-a-valid-objectid' }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Invalid template ID');
  });

  it('should activate template and return it', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    const templateId = '507f1f77bcf86cd799439011';
    const mockTemplate = {
      _id: { toString: () => templateId },
      tradingStyle: 'scalping',
      version: 2,
      weights: { rsi: 0.3, macd: 0.7 },
      thresholds: { buyThreshold: 0.6, sellThreshold: -0.6 },
      performanceMetrics: { avgSharpe: 1.5, avgWinRate: 0.65 },
      active: true,
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-15'),
    };
    mockActivateTemplate.mockResolvedValue(mockTemplate);

    const request = new Request('http://localhost:3000/api/admin/activate-template', {
      method: 'POST',
      body: JSON.stringify({ templateId }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.template).toBeDefined();
    expect(data.template.id).toBe(templateId);
    expect(data.template.tradingStyle).toBe('scalping');
    expect(data.template.version).toBe(2);
    expect(data.template.active).toBe(true);
    expect(mockConnectDB).toHaveBeenCalled();
    expect(mockActivateTemplate).toHaveBeenCalled();
  });

  it('should return 404 when template not found', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    mockActivateTemplate.mockRejectedValue(new Error('Template not found'));

    const request = new Request('http://localhost:3000/api/admin/activate-template', {
      method: 'POST',
      body: JSON.stringify({ templateId: '507f1f77bcf86cd799439011' }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe('Template not found');
  });

  it('should handle database errors', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    mockConnectDB.mockRejectedValue(new Error('Connection failed'));

    const request = new Request('http://localhost:3000/api/admin/activate-template', {
      method: 'POST',
      body: JSON.stringify({ templateId: '507f1f77bcf86cd799439011' }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Internal server error');
  });

  it('should handle unexpected activation errors', async () => {
    process.env.ADMIN_EMAIL = 'admin@example.com';
    mockAuth.mockResolvedValue({ user: { email: 'admin@example.com' } });

    mockActivateTemplate.mockRejectedValue(new Error('Unexpected error'));

    const request = new Request('http://localhost:3000/api/admin/activate-template', {
      method: 'POST',
      body: JSON.stringify({ templateId: '507f1f77bcf86cd799439011' }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toBe('Internal server error');
  });
});
