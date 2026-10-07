/**
 * Market recorder: a forward-only collector of the Binance USDT-M data the
 * public archive (data.binance.vision) does not keep, stored as compact
 * aggregates. DATA INFRASTRUCTURE, NOT EXECUTION: nothing here trades, scores
 * or signals.
 *
 * NO TEST MAY USE THIS DATA BEFORE A PRE-REGISTRATION WITH ITS OWN POWER
 * CALCULATION AND READ RULE (the 2026-10-01 review lesson). It is forward-only,
 * so the sample is fixed by the calendar; a study that looks first and
 * registers second has spent it.
 *
 * What it records (track T3, plan next-data-tracks-2026-10-07):
 *
 *   liquidationevents   every `!forceOrder@arr` event, all symbols. Binance's
 *                       forceOrder stream sends AT MOST THE LATEST LIQUIDATION
 *                       PER SYMBOL PER 1,000 MS, so this is an incomplete
 *                       record and its totals are a lower bound. Every
 *                       vendor's liquidation data comes from the same stream
 *                       and shares the limit.
 *   tradeflowbars       per symbol, 5-minute UTC buckets by trade time folded
 *                       from `<symbol>@aggTrade`: taker buy and sell base and
 *                       quote volume, quote split by trade notional (< 10k,
 *                       10k to 100k, >= 100k USDT), first, last, high and low
 *                       price, first and last aggregate id, fill count, and
 *                       `complete: false` when the connection was down inside
 *                       the bucket. Raw trades are never stored.
 *   recordergaps        every span with no connection, with its reason.
 *   recordersymbolsets  the top-N set at start and every 24 hours.
 *   jobheartbeats       row `market-recorder`, every minute, read by
 *                       /api/health/cron like any cron job.
 *
 * Universe: the top RECORDER_TOP_N (default 50) USDT-M perpetuals with
 * contractType PERPETUAL, status TRADING, quoteAsset USDT, underlyingType
 * COIN, ranked by 24h quote volume.
 *
 * Stream: one combined connection to `<BINANCE_FUTURES_WS_URL>/stream?streams=`
 * with `!forceOrder@arr` and one aggTrade stream per symbol, all in the URL.
 * The base defaults to `wss://fstream.binance.com/market`: since Binance's
 * 2026-04-23 routing change the legacy path without `/market` still accepts
 * the connection but delivers neither stream (checked live on 2026-10-08), so
 * an override must keep the route. Connection lifecycle, gaps and buffering
 * are in `src/lib/market-recorder/recorder.ts`.
 *
 * Storage growth, measured on a live run (2026-10-07): 14,400 trade-flow
 * documents a day at 50 symbols at 424 bytes of BSON each (about 6 MB), and
 * about 34,000 liquidation documents a day on a quiet evening at 316 bytes
 * each (about 11 MB; several times that on a volatile day). Roughly 17 MB a
 * day, 6 GB a year, before WiredTiger compression and indexes. No TTL: this
 * is research data.
 *
 * Runs as the `recorder` service in docker-compose.server.yml (seeder image,
 * `npx --yes --prefer-offline tsx scripts/ops/market-recorder.ts`). SIGTERM
 * or SIGINT flushes every open bucket (the last marked incomplete), writes an
 * open-ended shutdown gap and exits; a second signal exits at once.
 *
 * Environment:
 *   MONGODB_URI              required
 *   RECORDER_TOP_N           1 to 200, default 50
 *   BINANCE_FUTURES_WS_URL   default wss://fstream.binance.com/market
 *   BINANCE_FUTURES_API_URL  default https://fapi.binance.com (REST, for the ranking)
 */
import { connectDB } from '@/lib/mongodb';
import { MarketRecorder, webSocketFactory, type WebSocketConstructor } from '@/lib/market-recorder/recorder';
import { createMongoRecorderStore, ensureRecorderIndexes } from '@/lib/market-recorder/store';
import {
  DEFAULT_FUTURES_REST_BASE,
  DEFAULT_FUTURES_WS_BASE,
  fetchRecorderUniverse,
} from '@/lib/market-recorder/symbols';

export const DEFAULT_TOP_N = 50;
/** URL length and Binance's 1,024 streams per connection both stay comfortable below this. */
export const MAX_TOP_N = 200;

export interface RecorderEnv {
  topN: number;
  wsBaseUrl: string;
  restBaseUrl: string;
}

export function readRecorderEnv(env: Record<string, string | undefined> = process.env): RecorderEnv {
  const rawTopN = env.RECORDER_TOP_N?.trim();
  let topN = DEFAULT_TOP_N;
  if (rawTopN) {
    if (!/^\d+$/.test(rawTopN)) throw new Error(`RECORDER_TOP_N must be a whole number, got "${rawTopN}"`);
    topN = Number(rawTopN);
    if (topN < 1 || topN > MAX_TOP_N) throw new Error(`RECORDER_TOP_N must be 1 to ${MAX_TOP_N}, got ${topN}`);
  }

  const wsBaseUrl = env.BINANCE_FUTURES_WS_URL?.trim() || DEFAULT_FUTURES_WS_BASE;
  if (!/^wss?:\/\//.test(wsBaseUrl)) {
    throw new Error(`BINANCE_FUTURES_WS_URL must start with wss:// or ws://, got "${wsBaseUrl}"`);
  }
  const restBaseUrl = env.BINANCE_FUTURES_API_URL?.trim() || DEFAULT_FUTURES_REST_BASE;

  return { topN, wsBaseUrl, restBaseUrl };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function main(): Promise<number> {
  const env = readRecorderEnv();
  const Ctor = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (!Ctor) throw new Error('No global WebSocket: the recorder needs Node 22 or later');

  await connectDB();
  await ensureRecorderIndexes();

  const recorder = new MarketRecorder({
    socketFactory: webSocketFactory(Ctor),
    store: createMongoRecorderStore(),
    fetchUniverse: () => fetchRecorderUniverse(env.restBaseUrl, env.topN),
    wsBaseUrl: env.wsBaseUrl,
  });

  return new Promise<number>((resolve) => {
    let signalled = false;
    const onSignal = (signal: NodeJS.Signals) => {
      if (signalled) {
        console.error(JSON.stringify({ event: 'forced-exit', signal }));
        process.exit(1);
      }
      signalled = true;
      recorder.stop(signal).then(
        () => resolve(0),
        (err) => {
          console.error(JSON.stringify({ event: 'stop-error', error: errorMessage(err) }));
          resolve(1);
        }
      );
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);

    recorder.start().catch((err) => {
      console.error(JSON.stringify({ event: 'start-error', error: errorMessage(err) }));
      void recorder.stop('start-error').then(() => resolve(1));
    });
  });
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(JSON.stringify({ event: 'fatal', error: errorMessage(err) }));
      process.exit(1);
    });
}
