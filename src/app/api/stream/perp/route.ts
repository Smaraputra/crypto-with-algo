import { createStreamRelayHandler } from '@/lib/market-stream/relay';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Server-Sent Events relay for Binance USDT-M perpetual market streams.
 *
 * Upstream base is wss://fstream.binance.com/market because tests on
 * 2026-10-21 showed the combined stream works at /market/stream?streams=...
 * while the older /ws/... path connects but delivers no frames.
 */
export const GET = createStreamRelayHandler({
  envVar: 'BINANCE_FUTURES_WS_URL',
  defaultBase: 'wss://fstream.binance.com/market',
});
