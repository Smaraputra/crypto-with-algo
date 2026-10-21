import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fetchPerpKlinesRange, type PerpKline } from '@/lib/binance-futures';
import { rankAt, segmentContracts, stableStringify, type Contract } from './broad-trend';
import type { PerpCandleRow } from './dataset-format';
import { classifyFolder, exchangeMapFromJson } from './universe-source';

export interface UniverseArgs {
  asOf: string;
  top: number;
  exchangeInfo: string;
  out: string;
  delayMs: number;
}

export function parseArgs(argv: string[]): UniverseArgs {
  let asOf: string | null = null;
  let top = 30;
  let exchangeInfo: string | null = null;
  let out: string | null = null;
  let delayMs = 400;

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
      }
      return v;
    };

    if (flag === '--as-of') {
      asOf = value();
    } else if (flag === '--top') {
      const raw = value();
      const n = parseInt(raw, 10);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`--top must be a positive integer, got ${raw}`);
      }
      top = n;
    } else if (flag === '--exchange-info') {
      exchangeInfo = value();
    } else if (flag === '--out') {
      out = value();
    } else if (flag === '--delay-ms') {
      const raw = value();
      const n = parseInt(raw, 10);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`--delay-ms must be a non-negative integer, got ${raw}`);
      }
      delayMs = n;
    } else {
      throw new Error(`Unknown flag "${flag}"`);
    }
  }

  if (!asOf) throw new Error('--as-of is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new Error('--as-of must be formatted YYYY-MM-DD');
  }
  if (isNaN(Date.parse(`${asOf}T00:00:00.000Z`))) {
    throw new Error(`--as-of is not a valid date: ${asOf}`);
  }
  if (!exchangeInfo) throw new Error('--exchange-info is required');
  if (!out) throw new Error('--out is required');

  return { asOf, top, exchangeInfo, out, delayMs };
}

export interface UniverseMember {
  rank: number;
  symbol: string;
  assetKey: string;
  medianQuoteVolume: number;
}

export interface UniverseResult {
  asOf: string;
  top: number;
  candidates: string[];
  skippedTooNew: number;
  failed: string[];
  failedReasons: Record<string, string>;
  members: UniverseMember[];
}

export interface BuildUniverseInput {
  asOfMs: number;
  top: number;
  exchangeInfo: unknown;
  fetchKlines: typeof fetchPerpKlinesRange;
  asOf?: string;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DAY_MS = 86_400_000;

export async function buildUniverse(input: BuildUniverseInput): Promise<UniverseResult> {
  const raw = input.exchangeInfo as { symbols?: Array<{ symbol: string; status?: string }> };
  if (!raw || !Array.isArray(raw.symbols)) {
    throw new Error('exchangeInfo JSON has no symbols array');
  }

  const map = exchangeMapFromJson(input.exchangeInfo);
  const candidates: string[] = [];
  let skippedTooNew = 0;
  const minOnboardDate = input.asOfMs - 366 * DAY_MS;

  for (const s of raw.symbols) {
    if (s.status === 'TRADING' && classifyFolder(s.symbol, map).include) {
      const entry = map.get(s.symbol);
      if (entry && entry.onboardDate !== null && entry.onboardDate > minOnboardDate) {
        skippedTooNew++;
        continue;
      }
      candidates.push(s.symbol);
    }
  }

  const startTime = input.asOfMs - 400 * DAY_MS;
  const endTime = input.asOfMs - 1;

  type CandidateOutcome =
    | { success: true; symbol: string; rows: PerpCandleRow[] }
    | { success: false; symbol: string };

  const delayMs = input.delayMs ?? 400;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const outcomes = new Array<CandidateOutcome>(candidates.length);
  const failedReasons: Record<string, string> = {};

  for (let idx = 0; idx < candidates.length; idx++) {
    const symbol = candidates[idx];
    if (idx > 0 && delayMs > 0) {
      await sleep(delayMs);
    }

    let klines: PerpKline[] | null = null;
    let lastErrorMsg = '';

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        klines = await input.fetchKlines(symbol, '1d', startTime, endTime);
        break;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        lastErrorMsg = msg;
        if (msg.includes('418') || msg.includes('429') || msg.includes('-1003')) {
          throw new Error(`Binance rate limit encountered: ${msg}`);
        }
        if (attempt === 0) {
          await sleep(5000);
        }
      }
    }

    if (klines === null) {
      outcomes[idx] = { success: false, symbol };
      failedReasons[symbol] = lastErrorMsg;
    } else {
      const rows: PerpCandleRow[] = klines.map((k) => ({
        t: k.openTime,
        o: k.open,
        h: k.high,
        l: k.low,
        c: k.close,
        v: k.volume,
        qv: k.quoteVolume,
        n: k.trades,
        tbv: k.takerBuyVolume ?? null,
      }));
      outcomes[idx] = { success: true, symbol, rows };
    }
  }

  const failed: string[] = [];
  const contracts: Contract[] = [];
  for (const outcome of outcomes) {
    if (!outcome.success) {
      failed.push(outcome.symbol);
    } else {
      contracts.push(...segmentContracts(outcome.symbol, outcome.rows));
    }
  }

  const members = rankAt(contracts, input.asOfMs, { minBars: 366, topN: input.top });

  const asOf = input.asOf ?? new Date(input.asOfMs).toISOString().slice(0, 10);
  return {
    asOf,
    top: input.top,
    candidates,
    skippedTooNew,
    failed,
    failedReasons,
    members: members.map(({ rank, symbol, assetKey, volume }) => ({
      rank,
      symbol,
      assetKey,
      medianQuoteVolume: volume,
    })),
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const rawExchangeInfo = readFileSync(args.exchangeInfo);
  const exchangeInfoSha256 = createHash('sha256').update(rawExchangeInfo).digest('hex');
  const exchangeInfo = JSON.parse(rawExchangeInfo.toString('utf8'));
  const asOfMs = Date.parse(`${args.asOf}T00:00:00.000Z`);

  const universe = await buildUniverse({
    asOf: args.asOf,
    asOfMs,
    top: args.top,
    exchangeInfo,
    fetchKlines: fetchPerpKlinesRange,
    delayMs: args.delayMs,
  });

  const rest = {
    ...universe,
    exchangeInfoSha256,
  };
  const sha256 = createHash('sha256').update(stableStringify(rest)).digest('hex');
  const output = {
    ...rest,
    sha256,
  };

  const dir = dirname(args.out);
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(args.out, JSON.stringify(output, null, 2) + '\n', 'utf8');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
