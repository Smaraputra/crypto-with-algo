/**
 * Universe source for the broad trend phase: lists the archive, classifies every folder by the rules
 * pre-registered in broad-trend.ts (CANDIDATES AND CLASSES), and records the exact files each included
 * folder has. Data tooling only: no returns, no signals, no database writes.
 *
 * Usage:
 *   npx tsx scripts/research/universe-source.ts --exchange-info <exchangeInfo.json> --out <universe.json>
 *
 * The script never fetches exchangeInfo (reachable only from the VPS); pass a saved copy. Its sha256 is
 * recorded in the output. Network use is read-only bucket listing.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { listKeys, listPrefixes } from '@/lib/external/binance-archive-listing';
import { ARCHIVE_CONTRACT_SHAPE } from '@/lib/symbol-shape';

export const MONTHLY_KLINES_PREFIX = 'data/futures/um/monthly/klines/';
export const DAILY_KLINES_PREFIX = 'data/futures/um/daily/klines/';
export const MONTHLY_FUNDING_PREFIX = 'data/futures/um/monthly/fundingRate/';

export interface ExchangeEntry {
  contractType: string;
  underlyingType: string;
  quoteAsset: string;
  baseAsset: string;
  status: string;
  onboardDate: number | null;
  deliveryDate: number | null;
}

export interface Classification {
  include: boolean;
  reason: string;
}

/**
 * Header: "baseAsset is not a stable or gold-backed asset (USDC, USDT, FDUSD, TUSD, BUSD, USDP, DAI, USDE,
 * PYUSD, USD1, RLUSD, EUR, EURI, PAXG, XAUT)".
 */
export const STABLE_OR_GOLD_ASSETS: ReadonlySet<string> = new Set([
  'USDC', 'USDT', 'FDUSD', 'TUSD', 'BUSD', 'USDP', 'DAI', 'USDE', 'PYUSD', 'USD1', 'RLUSD', 'EUR', 'EURI',
  'PAXG', 'XAUT',
]);

/** Header: "indices excluded (BLUEBIRDUSDT, FOOTBALLUSDT, DOTECOUSDT)". */
export const ABSENT_INDEX_TICKERS: ReadonlySet<string> = new Set(['BLUEBIRDUSDT', 'FOOTBALLUSDT', 'DOTECOUSDT']);

/** Header: "crypto included (1000BTTCUSDT, AERGOUSDT, ... YFIIUSDT)", the 28 absent crypto tickers. */
export const ABSENT_CRYPTO_TICKERS: ReadonlySet<string> = new Set([
  '1000BTTCUSDT', 'AERGOUSDT', 'AKROUSDT', 'ANCUSDT', 'ANTUSDT', 'AUDIOUSDT', 'BDXNUSDT', 'BTCSTUSDT',
  'BTSUSDT', 'BTTUSDT', 'BZRXUSDT', 'COCOSUSDT', 'DODOUSDT', 'EOSUSDT', 'FRONTUSDT', 'GALUSDT', 'HNTUSDT',
  'KEEPUSDT', 'LENDUSDT', 'LUNAUSDT', 'MATICUSDT', 'MBLUSDT', 'NUUSDT', 'RNDRUSDT', 'SRMUSDT', 'SXPUSDT',
  'TOMOUSDT', 'YFIIUSDT',
]);

/** Header: "A folder's base ticker is its name without trailing SETTLED repeats." */
export function baseTicker(folder: string): string {
  return folder.replace(/(SETTLED)+$/, '');
}

/**
 * Header: "Asset key: the base ticker without USDT and without a leading multiplier prefix (1000000, 1000,
 * 1M)." Tried in that order; a prefix is stripped only when something remains.
 */
export function assetKey(folder: string): string {
  const base = baseTicker(folder);
  const bare = base.endsWith('USDT') ? base.slice(0, -4) : base;
  for (const prefix of ['1000000', '1000', '1M']) {
    if (bare.startsWith(prefix) && bare.length > prefix.length) return bare.slice(prefix.length);
  }
  return bare;
}

/** The class of a folder that fails the candidate shape, named for the report. */
function shapeClass(name: string): string {
  if (/[^\x20-\x7E]/.test(name)) return 'non-ascii';
  if (/_\d{6}$/.test(name)) return 'dated-quarterly';
  if (name.includes('_')) return 'underscore-other';
  if (/USDC$/.test(name)) return 'usdc-quoted';
  if (/(BUSD|USD1|BTC|ETH|U)$/.test(name)) return 'other-quote';
  return 'other-shape';
}

/**
 * Header: "A folder is a candidate only if its name matches ^[A-Z0-9]+USDT(SETTLED)*$; every other folder
 * is excluded and counted." then the exchangeInfo class, then the explicit lists for absent tickers.
 */
export function classifyFolder(
  name: string,
  exchangeBySymbol: ReadonlyMap<string, ExchangeEntry>
): Classification {
  if (!ARCHIVE_CONTRACT_SHAPE.test(name)) {
    return { include: false, reason: `shape:${shapeClass(name)}` };
  }

  const base = baseTicker(name);
  const entry = exchangeBySymbol.get(base);
  if (entry) {
    if (entry.contractType === 'TRADIFI_PERPETUAL') return { include: false, reason: 'exchange:tradfi' };
    if (entry.underlyingType === 'PREMARKET') return { include: false, reason: 'exchange:premarket' };
    if (entry.underlyingType === 'INDEX') return { include: false, reason: 'exchange:index' };
    if (entry.contractType !== 'PERPETUAL') {
      return { include: false, reason: `exchange:contract-type-${entry.contractType}` };
    }
    if (entry.underlyingType !== 'COIN') {
      return { include: false, reason: `exchange:underlying-${entry.underlyingType}` };
    }
    if (entry.quoteAsset !== 'USDT') return { include: false, reason: `exchange:quote-${entry.quoteAsset}` };
    if (STABLE_OR_GOLD_ASSETS.has(entry.baseAsset)) return { include: false, reason: 'exchange:stable-or-gold' };
    return { include: true, reason: 'exchange:perpetual-coin-usdt' };
  }

  if (ABSENT_INDEX_TICKERS.has(base)) return { include: false, reason: 'absent:index' };
  if (ABSENT_CRYPTO_TICKERS.has(base)) return { include: true, reason: 'absent:crypto' };
  return { include: false, reason: 'unclassified-absent' };
}

export function exchangeMapFromJson(json: unknown): Map<string, ExchangeEntry> {
  const symbols = (json as { symbols?: unknown }).symbols;
  if (!Array.isArray(symbols)) throw new Error('exchangeInfo JSON has no symbols array');
  const map = new Map<string, ExchangeEntry>();
  for (const raw of symbols as Array<Record<string, unknown>>) {
    if (typeof raw.symbol !== 'string') continue;
    map.set(raw.symbol, {
      contractType: String(raw.contractType),
      underlyingType: String(raw.underlyingType),
      quoteAsset: String(raw.quoteAsset),
      baseAsset: String(raw.baseAsset),
      status: String(raw.status),
      onboardDate: typeof raw.onboardDate === 'number' ? raw.onboardDate : null,
      deliveryDate: typeof raw.deliveryDate === 'number' ? raw.deliveryDate : null,
    });
  }
  return map;
}

/** Folder names from listing prefixes such as `data/futures/um/monthly/klines/BTCUSDT/`. */
export function folderNames(prefixes: string[], parent: string): string[] {
  return prefixes
    .filter((p) => p.startsWith(parent) && p.endsWith('/'))
    .map((p) => p.slice(parent.length, -1))
    .filter((n) => n.length > 0 && !n.includes('/'));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `YYYY-MM` months of a symbol's monthly files, from listing keys (`.CHECKSUM` siblings ignored). */
export function keyDates(keys: string[], symbol: string, middle: string, shape: 'month' | 'day'): string[] {
  const date = shape === 'month' ? '\\d{4}-\\d{2}' : '\\d{4}-\\d{2}-\\d{2}';
  const pattern = new RegExp(`(?:^|/)${escapeRegExp(symbol)}-${escapeRegExp(middle)}-(${date})\\.zip$`);
  const out: string[] = [];
  for (const key of keys) {
    const match = pattern.exec(key);
    if (match) out.push(match[1]);
  }
  return [...new Set(out)].sort();
}

export interface UniverseFolder {
  name: string;
  baseTicker: string;
  assetKey: string;
  include: boolean;
  reason: string;
  exchange: ExchangeEntry | null;
  klineMonths: string[];
  dailyKlines: { first: string; last: string; count: number } | null;
  fundingMonths: string[];
}

export interface UniverseSource {
  exchangeInfoSha256: string;
  folders: UniverseFolder[];
  counts: {
    folders: number;
    included: number;
    excluded: number;
    byReason: Record<string, number>;
  };
  sha256: string;
}

export interface Lister {
  listPrefixes: (prefix: string) => Promise<string[]>;
  listKeys: (prefix: string) => Promise<string[]>;
}

const DEFAULT_LISTER: Lister = { listPrefixes, listKeys };
const DEFAULT_CONCURRENCY = 8;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export function counted(folders: UniverseFolder[]): UniverseSource['counts'] {
  const byReason: Record<string, number> = {};
  for (const f of folders) byReason[f.reason] = (byReason[f.reason] ?? 0) + 1;
  const included = folders.filter((f) => f.include).length;
  return {
    folders: folders.length,
    included,
    excluded: folders.length - included,
    byReason: Object.fromEntries(Object.entries(byReason).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

/** sha256 of the content without the hash itself; nothing in it is a timestamp. */
export function universeHash(content: Omit<UniverseSource, 'sha256'>): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** Classify folders and list the files of the included ones. */
export async function buildUniverseSource(
  names: string[],
  exchangeBySymbol: ReadonlyMap<string, ExchangeEntry>,
  exchangeInfoSha256: string,
  lister: Lister = DEFAULT_LISTER,
  concurrency: number = DEFAULT_CONCURRENCY
): Promise<UniverseSource> {
  const unique = [...new Set(names)].sort();
  const folders = await mapLimit(unique, concurrency, async (name): Promise<UniverseFolder> => {
    const verdict = classifyFolder(name, exchangeBySymbol);
    const base = baseTicker(name);
    const folder: UniverseFolder = {
      name,
      baseTicker: base,
      assetKey: assetKey(name),
      include: verdict.include,
      reason: verdict.reason,
      exchange: exchangeBySymbol.get(base) ?? null,
      klineMonths: [],
      dailyKlines: null,
      fundingMonths: [],
    };
    if (!verdict.include) return folder;

    const [monthlyKeys, dailyKeys, fundingKeys] = await Promise.all([
      lister.listKeys(`${MONTHLY_KLINES_PREFIX}${name}/1d/`),
      lister.listKeys(`${DAILY_KLINES_PREFIX}${name}/1d/`),
      lister.listKeys(`${MONTHLY_FUNDING_PREFIX}${name}/`),
    ]);
    folder.klineMonths = keyDates(monthlyKeys, name, '1d', 'month');
    const days = keyDates(dailyKeys, name, '1d', 'day');
    folder.dailyKlines =
      days.length > 0 ? { first: days[0], last: days[days.length - 1], count: days.length } : null;
    folder.fundingMonths = keyDates(fundingKeys, name, 'fundingRate', 'month');
    return folder;
  });

  const content = { exchangeInfoSha256, folders, counts: counted(folders) };
  return { ...content, sha256: universeHash(content) };
}

function parseCliArgs(argv: string[]): { exchangeInfo: string; out: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument "${arg}"`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    flags.set(arg.slice(2), value);
    i++;
  }
  const exchangeInfo = flags.get('exchange-info');
  const out = flags.get('out');
  if (!exchangeInfo) throw new Error('--exchange-info <path> is required');
  if (!out) throw new Error('--out <path> is required');
  return { exchangeInfo, out };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { exchangeInfo, out } = parseCliArgs(argv);
  const raw = readFileSync(exchangeInfo);
  const exchangeInfoSha256 = createHash('sha256').update(raw).digest('hex');
  const exchange = exchangeMapFromJson(JSON.parse(raw.toString('utf8')));

  const monthly = folderNames(await listPrefixes(MONTHLY_KLINES_PREFIX), MONTHLY_KLINES_PREFIX);
  const daily = folderNames(await listPrefixes(DAILY_KLINES_PREFIX), DAILY_KLINES_PREFIX);
  const names = [...new Set([...monthly, ...daily])];
  console.error(`folders: ${monthly.length} monthly, ${daily.length} daily, ${names.length} union`);

  const source = await buildUniverseSource(names, exchange, exchangeInfoSha256);
  writeFileSync(out, `${JSON.stringify(source, null, 2)}\n`);
  console.error(JSON.stringify(source.counts));
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
