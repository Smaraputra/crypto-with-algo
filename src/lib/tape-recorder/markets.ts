import fs from 'node:fs';

import type { TapeMarket } from './types';

/**
 * The markets file: a JSON array of
 *   {"coin":"BTC","lighterMarketId":1,"binanceSymbol":"BTCUSDT"}
 * with `binanceSymbol` null for a Lighter-only market (a stock perp, say).
 * Validation collects every problem and throws once, so a bad file fails
 * loudly at start with the whole list.
 */

/**
 * Lighter allows 500 subscriptions on one connection and each market takes two
 * (book and prints), so 250 is the hard limit; 249 leaves one spare.
 */
export const MAX_MARKETS = 249;

export function parseMarkets(text: string, source = 'markets file'): TapeMarket[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${source} must be a JSON array`);
  if (parsed.length === 0) throw new Error(`${source} is empty`);
  if (parsed.length > MAX_MARKETS) {
    throw new Error(
      `${source} lists ${parsed.length} markets, more than the ${MAX_MARKETS} one Lighter connection can carry (500 subscriptions, 2 per market)`
    );
  }

  const errors: string[] = [];
  const markets: TapeMarket[] = [];
  const coins = new Set<string>();
  const ids = new Set<number>();
  const symbols = new Set<string>();

  parsed.forEach((entry: unknown, i) => {
    const at = `entry ${i}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (!['coin', 'lighterMarketId', 'binanceSymbol'].includes(key)) errors.push(`${at}: unknown field "${key}"`);
    }
    const { coin, lighterMarketId, binanceSymbol } = e;
    let ok = true;
    if (typeof coin !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(coin)) {
      errors.push(`${at}: coin must be a string of 1 to 32 letters, digits, dot, dash or underscore`);
      ok = false;
    } else if (coins.has(coin)) {
      errors.push(`${at}: duplicate coin "${coin}"`);
      ok = false;
    }
    if (typeof lighterMarketId !== 'number' || !Number.isInteger(lighterMarketId) || lighterMarketId < 0) {
      errors.push(`${at}: lighterMarketId must be a non-negative integer`);
      ok = false;
    } else if (ids.has(lighterMarketId)) {
      errors.push(`${at}: duplicate lighterMarketId ${lighterMarketId}`);
      ok = false;
    }
    if (binanceSymbol !== null) {
      if (typeof binanceSymbol !== 'string' || !/^[A-Z0-9]{3,30}$/.test(binanceSymbol)) {
        errors.push(`${at}: binanceSymbol must be null or an upper-case symbol such as "BTCUSDT"`);
        ok = false;
      } else if (symbols.has(binanceSymbol)) {
        errors.push(`${at}: duplicate binanceSymbol "${binanceSymbol}"`);
        ok = false;
      }
    }
    if (!ok) return;
    coins.add(coin as string);
    ids.add(lighterMarketId as number);
    if (binanceSymbol !== null) symbols.add(binanceSymbol as string);
    markets.push({ coin: coin as string, lighterMarketId: lighterMarketId as number, binanceSymbol: binanceSymbol as string | null });
  });

  if (errors.length > 0) throw new Error(`${source} is invalid:\n  ${errors.join('\n  ')}`);
  return markets;
}

export function loadMarkets(file: string): TapeMarket[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read markets file ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parseMarkets(text, file);
}
