/**
 * Tape recorder: a forward-only recorder of top-of-book and depth on Lighter
 * (a zero-fee perp DEX) and the matching Binance USDT-M perps, plus Lighter
 * trade prints, written as hourly gzip JSON Lines files. DATA INFRASTRUCTURE,
 * NOT EXECUTION: nothing here trades, scores or signals, and it uses no
 * database.
 *
 * Its purpose is to measure trading cost continuously, and to let a paper desk
 * simulate a taker fill that lands about 350 to 500 ms after a decision made
 * on a 5-minute UTC boundary. NO TEST MAY USE THIS DATA BEFORE A
 * PRE-REGISTRATION WITH ITS OWN READ RULE: it is forward-only, so the sample is
 * fixed by the calendar.
 *
 * Output, under TAPE_DIR (all UTC, numbers are numbers):
 *   YYYY-MM-DD/lighter-1s-HH.jsonl.gz     one row per market at every whole second
 *   YYYY-MM-DD/binance-1s-HH.jsonl.gz     the same from the 5-level Binance book
 *   YYYY-MM-DD/lighter-burst-HH.jsonl.gz  the same row every 100 ms from 1 s before
 *   YYYY-MM-DD/binance-burst-HH.jsonl.gz  to 3 s after every 5-minute boundary, with `g`
 *   YYYY-MM-DD/lighter-trades-HH.jsonl.gz every Lighter print
 *   gaps.jsonl                            append only, one line per span of lost data
 *   heartbeat.json                        rewritten every minute
 * Row fields and the read rule (use rows with ok true) are in src/lib/tape-recorder/types.ts.
 * Files are written as `<name>.<ms>.tmp` and published when the hour closes or on shutdown, never
 * over an existing file: a restart inside the hour writes `<stream>-HH.part2.jsonl.gz`, then
 * `.part3`. A file that hit a write error is kept as `<name>.failed-<ms>`, not published.
 *
 * Markets file (TAPE_MARKETS_FILE), a JSON array:
 *   [{"coin":"BTC","lighterMarketId":1,"binanceSymbol":"BTCUSDT"},
 *    {"coin":"NVDA","lighterMarketId":123,"binanceSymbol":null}]
 *
 * Environment:
 *   TAPE_DIR                    required, output folder
 *   TAPE_MARKETS_FILE           required, the markets file
 *   TAPE_LIGHTER_WS_URL         default wss://mainnet.zklighter.elliot.ai/stream?readonly=true
 *   TAPE_BINANCE_WS_URL         default wss://fstream.binance.com/public (book streams are
 *                               served under /public, not /market)
 *   TAPE_LIGHTER_MSGS_PER_MIN   1 to 190, default 150 (Lighter allows 200 client messages a minute)
 *   TAPE_STALE_AFTER_MS         5000 to 600000, default 30000
 *   TAPE_BUFFER_SOFT_MB         1 to 6, default 4 (burst rows are dropped above this per stream, every
 *                               row above 4 times this; at most 10 streams are open at an hour change,
 *                               so 6 MB keeps the worst case under half of a 512 MB container)
 *   TAPE_MIN_FREE_GB            0 to 1000, default 10. Below this much free space on the TAPE_DIR volume
 *                               no row is written (feeds stay connected, gap reason disk-floor, shown in
 *                               the heartbeat) until space returns. 0 disables the floor.
 *
 * SIGTERM or SIGINT flushes and closes every file and exits; a second signal
 * exits at once. Runs as the `tape` service in docker-compose.server.yml.
 */
import path from 'node:path';

import { DEFAULT_BINANCE_WS_URL } from '@/lib/tape-recorder/binance-ws';
import { DEFAULT_LIGHTER_WS_URL } from '@/lib/tape-recorder/lighter-ws';
import { loadMarkets } from '@/lib/tape-recorder/markets';
import { TapeRecorder } from '@/lib/tape-recorder/recorder';
import { tapeSocketFactory, type TapeWebSocketConstructor } from '@/lib/tape-recorder/socket';

export interface TapeEnv {
  dir: string;
  marketsFile: string;
  lighterUrl: string;
  binanceUrl: string;
  msgsPerMinute: number;
  staleAfterMs: number;
  softLimitBytes: number;
  minFreeBytes: number;
}

function intEnv(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a whole number, got "${raw}"`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`${key} must be ${min} to ${max}, got ${value}`);
  return value;
}

function wsUrl(env: Record<string, string | undefined>, key: string, fallback: string): string {
  const value = env[key]?.trim() || fallback;
  if (!/^wss?:\/\//.test(value)) throw new Error(`${key} must start with wss:// or ws://, got "${value}"`);
  return value;
}

export function readTapeEnv(env: Record<string, string | undefined> = process.env): TapeEnv {
  const dir = env.TAPE_DIR?.trim();
  if (!dir) throw new Error('TAPE_DIR is required');
  const marketsFile = env.TAPE_MARKETS_FILE?.trim();
  if (!marketsFile) throw new Error('TAPE_MARKETS_FILE is required');
  return {
    dir: path.resolve(dir),
    marketsFile: path.resolve(marketsFile),
    lighterUrl: wsUrl(env, 'TAPE_LIGHTER_WS_URL', DEFAULT_LIGHTER_WS_URL),
    binanceUrl: wsUrl(env, 'TAPE_BINANCE_WS_URL', DEFAULT_BINANCE_WS_URL),
    msgsPerMinute: intEnv(env, 'TAPE_LIGHTER_MSGS_PER_MIN', 150, 1, 190),
    staleAfterMs: intEnv(env, 'TAPE_STALE_AFTER_MS', 30_000, 5_000, 600_000),
    softLimitBytes: intEnv(env, 'TAPE_BUFFER_SOFT_MB', 4, 1, 6) * 1024 * 1024,
    minFreeBytes: intEnv(env, 'TAPE_MIN_FREE_GB', 10, 0, 1000) * 1024 ** 3,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function main(): Promise<number> {
  const env = readTapeEnv();
  const markets = loadMarkets(env.marketsFile);
  const Ctor = (globalThis as { WebSocket?: TapeWebSocketConstructor }).WebSocket;
  if (!Ctor) throw new Error('No global WebSocket: the tape recorder needs Node 22 or later');

  const recorder = new TapeRecorder({
    markets,
    dir: env.dir,
    socketFactory: tapeSocketFactory(Ctor),
    lighterUrl: env.lighterUrl,
    binanceUrl: env.binanceUrl,
    config: {
      lighter: { msgsPerMinute: env.msgsPerMinute, staleAfterMs: env.staleAfterMs },
      binance: { staleAfterMs: env.staleAfterMs },
      sink: { softLimitBytes: env.softLimitBytes, hardLimitBytes: env.softLimitBytes * 4, minFreeBytes: env.minFreeBytes },
    },
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
