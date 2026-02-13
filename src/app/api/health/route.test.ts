import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockConnection, mockConnectDB } = vi.hoisted(() => ({
  mockConnection: { readyState: 1 },
  mockConnectDB: vi.fn(),
}));

vi.mock('mongoose', () => ({
  default: {
    connection: mockConnection,
  },
}));

vi.mock('@/lib/mongodb', () => ({
  connectDB: mockConnectDB,
}));

import { GET } from './route';

describe('GET /api/health', () => {
  beforeEach(() => {
    mockConnection.readyState = 1;
    mockConnectDB.mockReset();
    mockConnectDB.mockResolvedValue(undefined);
  });

  it('returns 200 with ok status when MongoDB is connected', async () => {
    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.mongodb).toBe('connected');
    expect(body.timestamp).toBeDefined();
    expect(typeof body.uptime).toBe('number');
  });

  it('returns 503 with degraded status when MongoDB is disconnected', async () => {
    mockConnection.readyState = 0;

    const res = await GET();
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.mongodb).toBe('disconnected');
  });

  it('returns 503 when MongoDB is connecting', async () => {
    mockConnection.readyState = 2;

    const res = await GET();
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.mongodb).toBe('connecting');
  });

  it('returns 503 when MongoDB is disconnecting', async () => {
    mockConnection.readyState = 3;

    const res = await GET();
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.mongodb).toBe('disconnecting');
  });

  it('returns 503 with error status when connectDB throws', async () => {
    mockConnectDB.mockRejectedValue(new Error('Connection refused'));

    const res = await GET();
    expect(res.status).toBe(503);

    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.mongodb).toBe('error');
  });

  it('calls connectDB on every request', async () => {
    await GET();
    expect(mockConnectDB).toHaveBeenCalledOnce();
  });
});
