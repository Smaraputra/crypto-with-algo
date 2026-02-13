import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GET } from './route';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/historical-snapshots', () => ({
  getHistoricalSnapshots: vi.fn(),
}));

describe('GET /api/historical-snapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should reject unauthenticated requests', async () => {
    const { auth } = await import('@/lib/auth');
    vi.mocked(auth).mockResolvedValue(null as never);

    const req = new Request('http://localhost:3000/api/historical-snapshots?symbol=BTCUSDT&interval=1h&startTime=1000&endTime=2000');
    const res = await GET(req);

    expect(res.status).toBe(401);
  });

  it('should reject invalid query parameters', async () => {
    const { auth } = await import('@/lib/auth');
    vi.mocked(auth).mockResolvedValue({
      user: { email: 'test@example.com' },
    } as never);

    const req = new Request('http://localhost:3000/api/historical-snapshots?symbol=&interval=invalid&startTime=abc&endTime=xyz');
    const res = await GET(req);

    expect(res.status).toBe(400);
  });

  it('should reject time range > 1 year', async () => {
    const { auth } = await import('@/lib/auth');
    vi.mocked(auth).mockResolvedValue({
      user: { email: 'test@example.com' },
    } as never);

    const startTime = Date.now() - 400 * 24 * 60 * 60 * 1000; // 400 days ago
    const endTime = Date.now();

    const req = new Request(`http://localhost:3000/api/historical-snapshots?symbol=BTCUSDT&interval=1h&startTime=${startTime}&endTime=${endTime}`);
    const res = await GET(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Time range too large');
  });

  it('should fetch historical snapshots', async () => {
    const { auth } = await import('@/lib/auth');
    const { getHistoricalSnapshots } = await import('@/lib/historical-snapshots');

    vi.mocked(auth).mockResolvedValue({
      user: { email: 'test@example.com' },
    } as never);

    const mockSnapshots = [
      {
        symbol: 'BTCUSDT',
        interval: '1h',
        timestamp: 1000,
        data: {},
        createdAt: new Date().toISOString(),
      },
    ];

    vi.mocked(getHistoricalSnapshots).mockResolvedValue(mockSnapshots as never);

    const startTime = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days ago
    const endTime = Date.now();

    const req = new Request(`http://localhost:3000/api/historical-snapshots?symbol=BTCUSDT&interval=1h&startTime=${startTime}&endTime=${endTime}`);
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.snapshots[0].symbol).toBe('BTCUSDT');
  });
});
