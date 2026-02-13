import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './route';
import type { ISignalTemplate } from '@/lib/models/signal-template';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/models/signal-template', () => ({
  SignalTemplate: {
    findOne: vi.fn(),
  },
}));

describe('GET /api/signal-templates/:style', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject unauthenticated requests', async () => {
    const { auth } = await import('@/lib/auth');
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = new Request('http://localhost:3000/api/signal-templates/day_trading');
    const res = await GET(req, { params: Promise.resolve({ style: 'day_trading' }) });

    expect(res.status).toBe(401);
  });

  it('should reject invalid trading style', async () => {
    const { auth } = await import('@/lib/auth');
    vi.mocked(auth).mockResolvedValue({
      user: { email: 'test@example.com' },
    } as never);

    const req = new Request('http://localhost:3000/api/signal-templates/invalid');
    const res = await GET(req, { params: Promise.resolve({ style: 'invalid' }) });

    expect(res.status).toBe(400);
  });

  it('should return 404 if template not found', async () => {
    const { auth } = await import('@/lib/auth');
    const { SignalTemplate } = await import('@/lib/models/signal-template');

    vi.mocked(auth).mockResolvedValue({
      user: { email: 'test@example.com' },
    } as never);

    const mockQuery = {
      sort: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(null),
    };

    vi.mocked(SignalTemplate.findOne).mockReturnValue(mockQuery as never);

    const req = new Request('http://localhost:3000/api/signal-templates/day_trading');
    const res = await GET(req, { params: Promise.resolve({ style: 'day_trading' }) });

    expect(res.status).toBe(404);
  });

  it('should fetch template for valid trading style', async () => {
    const { auth } = await import('@/lib/auth');
    const { SignalTemplate } = await import('@/lib/models/signal-template');

    vi.mocked(auth).mockResolvedValue({
      user: { email: 'test@example.com' },
    } as never);

    const mockTemplate: Partial<ISignalTemplate> = {
      tradingStyle: 'day_trading',
      version: 1,
      weights: {
        trend: 0.25,
        momentum: 0.30,
        volume: 0.20,
        volatility: 0.10,
        futures: 0.10,
        sentiment: 0.05,
      },
      thresholds: {
        entryThreshold: 40,
        exitThreshold: 10,
        shortEntryThreshold: -40,
        shortExitThreshold: -10,
      },
      active: true,
    };

    const mockQuery = {
      sort: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(mockTemplate),
    };

    vi.mocked(SignalTemplate.findOne).mockReturnValue(mockQuery as never);

    const req = new Request('http://localhost:3000/api/signal-templates/day_trading');
    const res = await GET(req, { params: Promise.resolve({ style: 'day_trading' }) });

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.template).toEqual(mockTemplate);
    expect(SignalTemplate.findOne).toHaveBeenCalledWith({
      tradingStyle: 'day_trading',
      active: true,
    });
  });
});
