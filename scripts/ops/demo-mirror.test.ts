// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type { MirrorReport } from '@/lib/execution/run-mirror';
import { formatReport, parseArgs } from './demo-mirror';

describe('parseArgs', () => {
  it('defaults to a dry run on the configured book', () => {
    expect(parseArgs([])).toEqual({ book: null, execute: false, json: false, mongoUri: null });
  });

  it('parses the book, execute, json and mongo uri', () => {
    expect(parseArgs(['--book', 'day_trading:1h', '--execute', '--json', '--mongo-uri', 'mongodb://x'])).toEqual({
      book: 'day_trading:1h',
      execute: true,
      json: true,
      mongoUri: 'mongodb://x',
    });
  });

  it('rejects an unknown flag and a missing value', () => {
    expect(() => parseArgs(['--nope'])).toThrow('Unknown flag "--nope"');
    expect(() => parseArgs(['--book'])).toThrow('--book requires a value');
    expect(() => parseArgs(['--book', '--execute'])).toThrow('--book requires a value');
  });
});

const BASE: MirrorReport = {
  book: 'day_trading:15m',
  dryRun: true,
  haltReason: null,
  balance: 5000,
  scale: 0.5,
  oneWay: true,
  canTrade: true,
  symbols: [
    {
      symbol: 'BTCUSDT',
      intents: ['OPEN BUY 0.005 BTCUSDT (the desk opened)', 'STOP_MARKET SELL 0.005 BTCUSDT @ 75000 id=x (attach the stop)'],
      sent: 0,
      failed: 0,
      errors: [],
      skipped: null,
    },
    { symbol: 'ETHUSDT', intents: [], sent: 0, failed: 0, errors: [], skipped: null },
    { symbol: 'XRPUSDT', intents: [], sent: 0, failed: 0, errors: [], skipped: 'the demo venue has this symbol BREAK' },
  ],
  totalIntents: 2,
  totalSent: 0,
  totalFailed: 0,
  strayPositions: [],
};

describe('formatReport', () => {
  it('prints the plan, the account state and the dry-run warning', () => {
    const text = formatReport(BASE);
    expect(text).toContain('mirror day_trading:15m (dry run), 2 intents, none sent');
    expect(text).toContain('balance 5000 USDT, scale 0.5000, one-way true, canTrade true');
    expect(text).toContain('  BTCUSDT:');
    expect(text).toContain('    OPEN BUY 0.005 BTCUSDT');
    expect(text).toContain('XRPUSDT: skipped, the demo venue has this symbol BREAK');
    expect(text).toContain('DRY RUN: nothing was sent');
    // A symbol with nothing to do is not listed at all.
    expect(text).not.toContain('ETHUSDT:');
  });

  it('prints only the halt reason when the tick halted', () => {
    const text = formatReport({ ...BASE, haltReason: 'the demo account is in Hedge Mode' });
    expect(text).toBe('mirror day_trading:15m HALTED: the demo account is in Hedge Mode');
    expect(text).not.toContain('balance');
  });

  it('shows errors and omits the dry-run warning on a live tick', () => {
    const text = formatReport({
      ...BASE,
      dryRun: false,
      totalSent: 1,
      totalFailed: 1,
      symbols: [{ ...BASE.symbols[0], sent: 1, failed: 1, errors: ['open: venue rejected'] }],
    });
    expect(text).toContain('1 sent, 1 failed');
    expect(text).toContain('ERROR open: venue rejected');
    expect(text).not.toContain('DRY RUN');
  });

  it('reports stray venue positions', () => {
    expect(formatReport({ ...BASE, strayPositions: ['PEPEUSDT amt=100'] })).toContain(
      'stray venue positions outside the signal set: PEPEUSDT amt=100'
    );
  });
});
