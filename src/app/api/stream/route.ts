/**
 * Server-Sent Events relay for Binance market streams.
 *
 * Why this relay exists:
 * The owner's ISP blocks direct browser access to Binance endpoints.
 * The server VPS can reach Binance directly, so this route connects to
 * the Binance WebSocket stream upstream and relays market data frames
 * down to the browser as Server-Sent Events from the app's own origin.
 *
 * Architecture and lifecycle:
 * - Single-user app: one upstream WebSocket connection per browser client.
 * - Heartbeat: sends SSE comment ping (: ping\n\n) every 15,000 ms to prevent
 *   Cloudflare, reverse proxies, and firewalls from dropping idle streams.
 * - Upstream lifetime: Binance closes raw WebSocket connections after 24 hours.
 *   When the upstream socket closes or errors, this route emits an
 *   upstream-closed event and terminates the SSE stream, allowing the
 *   browser EventSource to reconnect cleanly using the configured retry delay.
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  parseStreams,
  upstreamUrl,
  sseData,
  SSE_PING,
} from '@/lib/market-stream/streams';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DEFAULT_BINANCE_WS_URL = 'wss://stream.binance.com:9443';
const HEARTBEAT_INTERVAL_MS = 15000;
const RETRY_FRAME = 'retry: 3000\n\n';
const UPSTREAM_CLOSED_FRAME = 'event: upstream-closed\ndata: {}\n\n';

export async function GET(req: NextRequest): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = parseStreams(req.nextUrl.searchParams.get('streams'));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const base = process.env.BINANCE_WS_URL || DEFAULT_BINANCE_WS_URL;
  const upstream = upstreamUrl(base, parsed.streams);
  const ws = new WebSocket(upstream);

  const encoder = new TextEncoder();
  let closed = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;

  function safeEnqueue(data: string) {
    if (closed || !streamController) return;
    try {
      streamController.enqueue(encoder.encode(data));
    } catch {
      closed = true;
    }
  }

  function cleanupInterval() {
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function cleanupSocket() {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  function cleanupController() {
    if (streamController) {
      try {
        streamController.close();
      } catch {
        // ignore
      }
    }
  }

  function handleAbort() {
    if (closed) return;
    closed = true;
    cleanupInterval();
    cleanupSocket();
    cleanupController();
  }

  function handleUpstreamEnd() {
    if (closed) return;
    safeEnqueue(UPSTREAM_CLOSED_FRAME);
    closed = true;
    cleanupInterval();
    cleanupSocket();
    cleanupController();
  }

  const onMessage = (event: MessageEvent | { data: unknown }) => {
    safeEnqueue(sseData(String(event.data)));
  };

  const onClose = () => {
    handleUpstreamEnd();
  };

  const onError = () => {
    handleUpstreamEnd();
  };

  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', onClose);
  ws.addEventListener('error', onError);

  if (req.signal.aborted) {
    handleAbort();
  } else {
    req.signal.addEventListener('abort', handleAbort, { once: true });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (closed) {
        cleanupController();
        return;
      }
      safeEnqueue(RETRY_FRAME);
      intervalId = setInterval(() => {
        safeEnqueue(SSE_PING);
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      handleAbort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
