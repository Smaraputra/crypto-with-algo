/**
 * The explicit contract list shared by the research tooling: a JSON array of
 * `{ symbol, klineMonths?, fundingMonths?, klineDays? }`. Symbols reach cache
 * paths and archive URLs, so every symbol is checked against the archive-contract
 * shape, and dates are checked to be real calendar months and days.
 */
import { ARCHIVE_CONTRACT_SHAPE } from '@/lib/symbol-shape';

export interface ContractEntry {
  symbol: string;
  klineMonths?: string[];
  fundingMonths?: string[];
  klineDays?: string[];
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function checkedDates(value: unknown, field: string, symbol: string, shape: 'month' | 'day'): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${symbol}: ${field} must be an array`);
  const out = new Set<string>();
  for (const item of value) {
    const ok =
      typeof item === 'string' &&
      (shape === 'month'
        ? MONTH.test(item)
        : DAY.test(item) && new Date(`${item}T00:00:00Z`).toISOString().slice(0, 10) === item);
    if (!ok) throw new Error(`${symbol}: ${field} entry ${JSON.stringify(item)} is not a real ${shape === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'} date`);
    out.add(item as string);
  }
  return [...out].sort();
}

/** Pure validator for the parsed JSON. Duplicate symbols are refused, not merged. */
export function parseContractList(json: unknown): ContractEntry[] {
  if (!Array.isArray(json)) throw new Error('symbols file must be a JSON array');
  if (json.length === 0) throw new Error('symbols file is empty');
  const seen = new Set<string>();
  return json.map((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`symbols file entry ${index} is not an object`);
    }
    const record = raw as Record<string, unknown>;
    const symbol = record.symbol;
    if (typeof symbol !== 'string' || !ARCHIVE_CONTRACT_SHAPE.test(symbol)) {
      throw new Error(`symbols file entry ${index}: symbol ${JSON.stringify(symbol)} does not match the archive-contract shape`);
    }
    if (seen.has(symbol)) throw new Error(`symbols file lists ${symbol} twice`);
    seen.add(symbol);
    const klineMonths = checkedDates(record.klineMonths, 'klineMonths', symbol, 'month');
    const fundingMonths = checkedDates(record.fundingMonths, 'fundingMonths', symbol, 'month');
    const klineDays = checkedDates(record.klineDays, 'klineDays', symbol, 'day');
    return {
      symbol,
      ...(klineMonths ? { klineMonths } : {}),
      ...(fundingMonths ? { fundingMonths } : {}),
      ...(klineDays ? { klineDays } : {}),
    };
  });
}
