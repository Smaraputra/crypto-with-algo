// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  auth: mockAuth,
}));

import { GET } from './route';

type Listener = (event: unknown) => void;

class FakeWebSocket {
  url: string;
  close = vi.fn();
  listeners: Record<string, Listener[]> = {};

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: Listener) {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type].push(listener);
  }

  removeEventListener(type: string, listener: Listener) {
    if (this.listeners[type]) {
      this.listeners[type] = this.listeners[type].filter((l) => l !== listener);
    }
  }

  emit(type: string, data: unknown = {}) {
    const list = this.listeners[type] || [];
    for (const listener of list) {
      listener(data);
    }
  }
}

let latestSocket: FakeWebSocket | null = null;
let allSockets: FakeWebSocket[] = [];

const StubWebSocket = function (url: string) {
  const socket = new FakeWebSocket(url);
  latestSocket = socket;
  allSockets.push(socket);
  return socket;
};

beforeEach(() => {
  vi.clearAllMocks();
  latestSocket = null;
  allSockets = [];
  vi.stubGlobal('WebSocket', StubWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /api/stream/perp', () => {
  it('returns 401 when unauthenticated and creates no WebSocket', async () => {
    mockAuth.mockResolvedValue(null);
    const req = new NextRequest('http://localhost/api/stream/perp?streams=btcusdt@kline_1h');
    const res = await GET(req);

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ error: 'Unauthorized' });
    expect(allSockets.length).toBe(0);
  });

  it('returns 400 for invalid stream name and creates no WebSocket', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    const req = new NextRequest('http://localhost/api/stream/perp?streams=btcusdt@depth');
    const res = await GET(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: 'invalid stream: btcusdt@depth' });
    expect(allSockets.length).toBe(0);
  });

  it('opens upstream WebSocket at wss://fstream.binance.com/market/stream?streams=btcusdt@kline_1h for valid kline request', async () => {
    vi.stubEnv('BINANCE_FUTURES_WS_URL', '');
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    const req = new NextRequest('http://localhost/api/stream/perp?streams=btcusdt@kline_1h');
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(latestSocket).not.toBeNull();
    expect(latestSocket?.url).toBe(
      'wss://fstream.binance.com/market/stream?streams=btcusdt@kline_1h'
    );
  });

  it('uses BINANCE_FUTURES_WS_URL when set', async () => {
    vi.stubEnv('BINANCE_FUTURES_WS_URL', 'wss://custom-futures.binance.org/custom-market');
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    const req = new NextRequest('http://localhost/api/stream/perp?streams=btcusdt@kline_1h');
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(latestSocket?.url).toBe(
      'wss://custom-futures.binance.org/custom-market/stream?streams=btcusdt@kline_1h'
    );
  });
});
