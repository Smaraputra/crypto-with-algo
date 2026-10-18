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

describe('GET /api/stream', () => {
  it('returns 401 when session is absent and creates no WebSocket', async () => {
    mockAuth.mockResolvedValue(null);
    const req = new NextRequest('http://localhost/api/stream?streams=btcusdt@ticker');
    const res = await GET(req);

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json).toEqual({ error: 'Unauthorized' });
    expect(allSockets.length).toBe(0);
  });

  it('returns 400 for invalid streams with the exact error and creates no WebSocket', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    const req = new NextRequest('http://localhost/api/stream?streams=btcusdt@depth');
    const res = await GET(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({ error: 'invalid stream: btcusdt@depth' });
    expect(allSockets.length).toBe(0);
  });

  it('returns 200 with SSE headers and connects upstream using default base', async () => {
    vi.stubEnv('BINANCE_WS_URL', '');
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    const req = new NextRequest('http://localhost/api/stream?streams=btcusdt@ticker');
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform');
    expect(res.headers.get('Connection')).toBe('keep-alive');
    expect(res.headers.get('X-Accel-Buffering')).toBe('no');

    expect(latestSocket).not.toBeNull();
    expect(latestSocket?.url).toBe(
      'wss://stream.binance.com:9443/stream?streams=btcusdt@ticker'
    );
  });

  it('emits retry chunk on start and streams incoming websocket messages as SSE', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    const req = new NextRequest('http://localhost/api/stream?streams=btcusdt@ticker');
    const res = await GET(req);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const firstChunk = await reader.read();
    expect(firstChunk.done).toBe(false);
    expect(decoder.decode(firstChunk.value)).toBe('retry: 3000\n\n');

    latestSocket!.emit('message', {
      data: '{"stream":"btcusdt@ticker","data":{}}',
    });

    const secondChunk = await reader.read();
    expect(secondChunk.done).toBe(false);
    expect(decoder.decode(secondChunk.value)).toBe(
      'data: {"stream":"btcusdt@ticker","data":{}}\n\n'
    );
  });

  it('produces heartbeat ping when 15000 ms elapses', async () => {
    vi.useFakeTimers();
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    const req = new NextRequest('http://localhost/api/stream?streams=btcusdt@ticker');
    const res = await GET(req);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const firstChunk = await reader.read();
    expect(decoder.decode(firstChunk.value)).toBe('retry: 3000\n\n');

    vi.advanceTimersByTime(15000);

    const pingChunk = await reader.read();
    expect(pingChunk.done).toBe(false);
    expect(decoder.decode(pingChunk.value)).toBe(': ping\n\n');
  });

  it('produces upstream-closed event and closes stream when upstream closes', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    const req = new NextRequest('http://localhost/api/stream?streams=btcusdt@ticker');
    const res = await GET(req);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const firstChunk = await reader.read();
    expect(decoder.decode(firstChunk.value)).toBe('retry: 3000\n\n');

    latestSocket!.emit('close');

    const closedChunk = await reader.read();
    expect(closedChunk.done).toBe(false);
    expect(decoder.decode(closedChunk.value)).toBe(
      'event: upstream-closed\ndata: {}\n\n'
    );

    const doneChunk = await reader.read();
    expect(doneChunk.done).toBe(true);
  });

  it('produces upstream-closed event and closes stream when upstream errors', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    const req = new NextRequest('http://localhost/api/stream?streams=btcusdt@ticker');
    const res = await GET(req);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const firstChunk = await reader.read();
    expect(decoder.decode(firstChunk.value)).toBe('retry: 3000\n\n');

    latestSocket!.emit('error', new Error('upstream failure'));

    const closedChunk = await reader.read();
    expect(closedChunk.done).toBe(false);
    expect(decoder.decode(closedChunk.value)).toBe(
      'event: upstream-closed\ndata: {}\n\n'
    );

    const doneChunk = await reader.read();
    expect(doneChunk.done).toBe(true);
  });

  it('closes fake socket when request signal is aborted', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    const controller = new AbortController();
    const req = new NextRequest('http://localhost/api/stream?streams=btcusdt@ticker', {
      signal: controller.signal,
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(latestSocket).not.toBeNull();
    expect(latestSocket!.close).not.toHaveBeenCalled();

    controller.abort();
    expect(latestSocket!.close).toHaveBeenCalled();
  });

  it('respects BINANCE_WS_URL environment variable', async () => {
    vi.stubEnv('BINANCE_WS_URL', 'wss://custom-stream.binance.org');
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    const req = new NextRequest('http://localhost/api/stream?streams=btcusdt@ticker');
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(latestSocket?.url).toBe(
      'wss://custom-stream.binance.org/stream?streams=btcusdt@ticker'
    );
  });

  it('keeps the monthly interval case in the upstream URL', async () => {
    vi.stubEnv('BINANCE_WS_URL', '');
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    const req = new NextRequest('http://localhost/api/stream?streams=BTCUSDT@kline_1M');
    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(latestSocket?.url).toBe(
      'wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1M'
    );
  });

  it('closes the body and starts no heartbeat when the request was aborted before the stream started', async () => {
    vi.useFakeTimers();
    mockAuth.mockResolvedValue({ user: { id: 'user-1' } });
    const controller = new AbortController();
    controller.abort();
    const req = new NextRequest('http://localhost/api/stream?streams=btcusdt@ticker', {
      signal: controller.signal,
    });
    const res = await GET(req);

    expect(latestSocket!.close).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(true);
  });
});
