/**
 * Bucket listing for the Binance public data archive (S3 ListBucketResult XML).
 *
 * The archive is plain S3, so what exists can be listed rather than guessed by
 * probing 404s. A listing page holds at most 1000 entries; when it is
 * truncated the next page is requested with `marker`. With a delimiter,
 * folders come back as CommonPrefixes; without one, files come back as
 * Contents keys.
 *
 * The listing host is the bucket's regional S3 endpoint, not data.binance.vision
 * itself (the CDN front serves files only). Override with BINANCE_ARCHIVE_LIST_URL.
 */

const DEFAULT_LIST_URL = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision';

/** Read at call time, never cached, like BINANCE_ARCHIVE_URL. */
function getListUrl(): string {
  return (process.env.BINANCE_ARCHIVE_LIST_URL || DEFAULT_LIST_URL).replace(/\/+$/, '');
}

export interface S3Listing {
  prefixes: string[];
  keys: string[];
  isTruncated: boolean;
  nextMarker: string | null;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? whole;
  });
}

function collect(xml: string, outer: string, inner: string): string[] {
  const out: string[] = [];
  const block = new RegExp(`<${outer}>([\\s\\S]*?)</${outer}>`, 'g');
  const field = new RegExp(`<${inner}>([\\s\\S]*?)</${inner}>`);
  for (const match of xml.matchAll(block)) {
    const found = field.exec(match[1]);
    if (found) out.push(decodeEntities(found[1]));
  }
  return out;
}

/**
 * Pure parser for one listing page. When the page is truncated and carries no
 * NextMarker (S3 omits it without a delimiter), the next marker is the last
 * key or prefix, whichever sorts later, as S3's own contract says.
 */
export function parseS3Listing(xml: string): S3Listing {
  const prefixes = collect(xml, 'CommonPrefixes', 'Prefix');
  const keys = collect(xml, 'Contents', 'Key');
  const isTruncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);

  let nextMarker: string | null = null;
  if (isTruncated) {
    const explicit = /<NextMarker>([\s\S]*?)<\/NextMarker>/.exec(xml);
    if (explicit) {
      nextMarker = decodeEntities(explicit[1]);
    } else {
      const last = [...prefixes.slice(-1), ...keys.slice(-1)].sort().pop();
      nextMarker = last ?? null;
    }
  }
  return { prefixes, keys, isTruncated, nextMarker };
}

const FETCH_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 500;
/** A hard stop against a listing that never ends. 1,056 folders is two pages. */
const MAX_PAGES = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ListOptions {
  /** Base backoff in ms. Tests pass 0; nothing in production should set it. */
  retryBaseMs?: number;
}

async function fetchPage(url: string, retryBaseMs: number): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0 && retryBaseMs > 0) await sleep(retryBaseMs * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) return await res.text();
      const error = new Error(`Archive listing failed: HTTP ${res.status} for ${url}`);
      // A 4xx is a bad request, not a blip: do not retry it.
      if (res.status < 500) throw Object.assign(error, { fatal: true });
      lastError = error;
    } catch (error) {
      if (error instanceof Error && (error as { fatal?: boolean }).fatal) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Archive listing failed after ${MAX_ATTEMPTS} attempts for ${url}`);
}

async function listAll(
  prefix: string,
  delimiter: boolean,
  options: ListOptions
): Promise<S3Listing> {
  const retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
  const prefixes: string[] = [];
  const keys: string[] = [];
  let marker: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams();
    if (delimiter) params.set('delimiter', '/');
    params.set('prefix', prefix);
    if (marker) params.set('marker', marker);
    const xml = await fetchPage(`${getListUrl()}?${params.toString()}`, retryBaseMs);
    const parsed = parseS3Listing(xml);
    prefixes.push(...parsed.prefixes);
    keys.push(...parsed.keys);
    if (!parsed.isTruncated) return { prefixes, keys, isTruncated: false, nextMarker: null };
    if (!parsed.nextMarker || parsed.nextMarker === marker) {
      throw new Error(`Archive listing for "${prefix}" is truncated but cannot advance`);
    }
    marker = parsed.nextMarker;
  }
  throw new Error(`Archive listing for "${prefix}" exceeded ${MAX_PAGES} pages`);
}

/** Every folder directly under `prefix` (full prefixes, trailing slash kept). */
export async function listPrefixes(prefix: string, options: ListOptions = {}): Promise<string[]> {
  return (await listAll(prefix, true, options)).prefixes;
}

/** Every key under `prefix` (recursive), `.CHECKSUM` siblings included. */
export async function listKeys(prefix: string, options: ListOptions = {}): Promise<string[]> {
  return (await listAll(prefix, false, options)).keys;
}
