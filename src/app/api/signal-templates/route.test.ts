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
    find: vi.fn(),
  },
}));

describe('GET /api/signal-templates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject unauthenticated requests', async () => {
    const { auth } = await import('@/lib/auth');
    vi.mocked(auth).mockResolvedValue(null as never);

    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('should fetch active signal templates', async () => {
    const { auth } = await import('@/lib/auth');
    const { SignalTemplate } = await import('@/lib/models/signal-template');

    vi.mocked(auth).mockResolvedValue({
      user: { email: 'test@example.com' },
    } as never);

    const mockTemplates: Partial<ISignalTemplate>[] = [
      {
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
        active: true,
      },
      {
        tradingStyle: 'swing_trading',
        version: 1,
        weights: {
          trend: 0.30,
          momentum: 0.20,
          volume: 0.10,
          volatility: 0.10,
          futures: 0.20,
          sentiment: 0.10,
        },
        active: true,
      },
    ];

    const mockQuery = {
      sort: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(mockTemplates),
    };

    vi.mocked(SignalTemplate.find).mockReturnValue(mockQuery as never);

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.templates).toEqual(mockTemplates);
    expect(SignalTemplate.find).toHaveBeenCalledWith({ active: true });
  });
});
