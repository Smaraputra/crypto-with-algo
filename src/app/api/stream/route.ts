import { createStreamRelayHandler } from '@/lib/market-stream/relay';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = createStreamRelayHandler({
  envVar: 'BINANCE_WS_URL',
  defaultBase: 'wss://stream.binance.com:9443',
});
