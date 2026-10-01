import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { PaperLedger, type IPaperLedger } from '@/lib/models/paper-ledger';
import { getCandles } from '@/lib/candle-ingestion';
import { BOOK_START_EQUITY, parseBookId, type BookKey } from '@/lib/paper-desk/books';
import {
  BinanceDemoClient,
  DemoExecutionError,
  type DemoAlgoOrder,
  type DemoPosition,
  type DemoVenueFilter,
} from './binance-demo';
import { describeIntent, planMirror, type DesiredPosition, type MirrorIntent } from './mirror';

/**
 * One tick of the demo mirror.
 *
 * Safe by default, in three independent layers, because this is the only path
 * in the repository that can move a position:
 *
 *  1. `DEMO_EXECUTION_ENABLED` must be exactly `'true'`. Anything else, unset
 *     included, is a dry run that logs the intents and sends nothing.
 *  2. The client itself refuses writes unless constructed with
 *     `writesEnabled`, so a bug here cannot place an order during a dry run.
 *  3. Pre-flight checks run before any intent is sent: the keys must work, the
 *     account must be able to trade, and it must be in one-way mode, because
 *     every exit uses `reduceOnly` which Binance rejects in Hedge Mode.
 *
 * The desk is the source of truth and is never written to here. A mirror
 * failure leaves the desk's own record untouched, which is what lets the
 * simulated measurement stand on its own.
 */

export const DEMO_BOOK_DEFAULT = 'day_trading:15m';

export interface MirrorSymbolReport {
  symbol: string;
  intents: string[];
  sent: number;
  failed: number;
  errors: string[];
  skipped: string | null;
}

export interface MirrorReport {
  book: string;
  dryRun: boolean;
  /** Why the tick did nothing at all, when it did nothing. */
  haltReason: string | null;
  balance: number | null;
  scale: number | null;
  oneWay: boolean | null;
  canTrade: boolean | null;
  symbols: MirrorSymbolReport[];
  totalIntents: number;
  totalSent: number;
  totalFailed: number;
  /** Venue positions in symbols the desk does not hold, which the mirror will close. */
  strayPositions: string[];
}

export interface RunMirrorOptions {
  /** Overrides DEMO_BOOK. */
  book?: string;
  /** Overrides DEMO_EXECUTION_ENABLED. */
  execute?: boolean;
  client?: BinanceDemoClient;
  log?: (line: string) => void;
}

/** True only for the exact string 'true', so a typo is never an enable. */
export function executionEnabled(raw: string | undefined): boolean {
  return raw === 'true';
}

/**
 * Demo quantity per unit of desk quantity.
 *
 * The desk sizes each symbol against a 1,000 USDT nominal ledger, and the demo
 * account has its own balance, so copying a desk quantity verbatim would mean
 * something different against a different equity. Scaling by the ratio keeps
 * the RISK FRACTION the same, which is the thing the research fixed at 1%.
 */
export function mirrorScale(demoBalance: number, symbolCount: number): number {
  const nominal = BOOK_START_EQUITY * symbolCount;
  if (!(nominal > 0) || !(demoBalance > 0)) return 0;
  return demoBalance / nominal;
}

/** The desk's open position for one symbol, as the mirror wants it. */
export function desiredFromLedger(ledger: IPaperLedger | null): DesiredPosition | null {
  const position = ledger?.position;
  if (!position) return null;
  return {
    symbol: ledger!.symbol,
    side: position.side,
    quantity: position.quantity,
    stopPrice: position.stopPrice,
    targetPrice: position.targetPrice,
  };
}

async function sendIntent(client: BinanceDemoClient, intent: MirrorIntent): Promise<void> {
  switch (intent.kind) {
    case 'open':
      await client.marketOrder({ symbol: intent.symbol, side: intent.side, quantity: intent.quantity });
      return;
    case 'close':
      await client.marketOrder({
        symbol: intent.symbol,
        side: intent.side,
        quantity: intent.quantity,
        reduceOnly: true,
      });
      return;
    case 'adjust':
      await client.marketOrder({
        symbol: intent.symbol,
        side: intent.side,
        quantity: intent.quantity,
        reduceOnly: intent.reduceOnly,
      });
      return;
    case 'protect':
      await client.conditionalOrder({
        symbol: intent.symbol,
        side: intent.side,
        type: intent.type,
        triggerPrice: intent.triggerPrice,
        quantity: intent.quantity,
        clientAlgoId: intent.clientAlgoId,
      });
      return;
    case 'cancel':
      await client.cancelAlgoOrder(intent.symbol, intent.algoId);
      return;
    case 'skip':
      return;
  }
}

export async function runMirror(options: RunMirrorOptions = {}): Promise<MirrorReport> {
  const log = options.log ?? (() => {});
  const bookId = options.book ?? process.env.DEMO_BOOK ?? DEMO_BOOK_DEFAULT;
  const dryRun = !(options.execute ?? executionEnabled(process.env.DEMO_EXECUTION_ENABLED));

  const report: MirrorReport = {
    book: bookId,
    dryRun,
    haltReason: null,
    balance: null,
    scale: null,
    oneWay: null,
    canTrade: null,
    symbols: [],
    totalIntents: 0,
    totalSent: 0,
    totalFailed: 0,
    strayPositions: [],
  };

  let key: BookKey;
  try {
    key = parseBookId(bookId);
  } catch (error) {
    report.haltReason = error instanceof Error ? error.message : String(error);
    return report;
  }

  const client = options.client ?? BinanceDemoClient.fromEnv({ writesEnabled: !dryRun });
  if (!client) {
    report.haltReason =
      'BINANCE_DEMO_API_KEY and BINANCE_DEMO_API_SECRET are not set; on the VPS they belong in /opt/sites/crypto/.env';
    return report;
  }

  log(`mirror ${bookId} ${dryRun ? '(DRY RUN: nothing will be sent)' : '(LIVE on the demo venue)'}`);

  // Pre-flight. A tick that cannot verify the account does nothing at all.
  try {
    const [perms, oneWay, balance] = await Promise.all([
      client.permissions(),
      client.isOneWayMode(),
      client.usdtBalance(),
    ]);
    report.canTrade = perms.canTrade;
    report.oneWay = oneWay;
    report.balance = balance;

    if (!perms.canTrade) {
      report.haltReason = 'the demo account reports canTrade false';
      return report;
    }
    if (!oneWay) {
      report.haltReason =
        'the demo account is in Hedge Mode; every mirror exit uses reduceOnly, which Binance rejects there';
      return report;
    }
    if (!(balance > 0)) {
      report.haltReason = 'the demo account has no USDT balance';
      return report;
    }
  } catch (error) {
    report.haltReason =
      error instanceof DemoExecutionError
        ? `pre-flight failed: ${error.message}`
        : `pre-flight failed: ${error instanceof Error ? error.message : String(error)}`;
    return report;
  }

  const scale = mirrorScale(report.balance, SIGNAL_SYMBOLS.length);
  report.scale = scale;
  log(`balance ${report.balance} USDT, scale ${scale.toPrecision(4)} per unit of desk size`);

  let filters: Map<string, DemoVenueFilter>;
  let positions: DemoPosition[];
  let algoOrders: DemoAlgoOrder[];
  try {
    [filters, positions, algoOrders] = await Promise.all([
      client.venueFilters(),
      client.openPositions(),
      client.openAlgoOrders(),
    ]);
  } catch (error) {
    report.haltReason = `could not read venue state: ${error instanceof Error ? error.message : String(error)}`;
    return report;
  }

  const ledgers = await PaperLedger.find({
    tradingStyle: key.tradingStyle,
    interval: key.interval,
  }).lean<IPaperLedger[]>();
  const bySymbol = new Map(ledgers.map((l) => [l.symbol, l]));

  // A venue position in a symbol the desk never traded: the mirror still owns
  // it, so it is reported and closed rather than silently left open.
  for (const p of positions) {
    if (!SIGNAL_SYMBOLS.includes(p.symbol as (typeof SIGNAL_SYMBOLS)[number])) {
      report.strayPositions.push(`${p.symbol} amt=${p.positionAmt}`);
    }
  }

  for (const symbol of SIGNAL_SYMBOLS) {
    const filter = filters.get(symbol);
    const symbolReport: MirrorSymbolReport = {
      symbol,
      intents: [],
      sent: 0,
      failed: 0,
      errors: [],
      skipped: null,
    };

    if (!filter) {
      symbolReport.skipped = 'the demo venue does not list this symbol';
      report.symbols.push(symbolReport);
      continue;
    }
    if (filter.status !== 'TRADING') {
      symbolReport.skipped = `the demo venue has this symbol ${filter.status}`;
      report.symbols.push(symbolReport);
      continue;
    }

    const desired = desiredFromLedger(bySymbol.get(symbol) ?? null);
    const actual = positions.find((p) => p.symbol === symbol) ?? null;
    const symbolAlgos = algoOrders.filter((o) => o.symbol === symbol);

    // Nothing to do and nothing held: skip the price read entirely.
    if (!desired && !actual && symbolAlgos.length === 0) {
      report.symbols.push(symbolReport);
      continue;
    }

    // The minimum-notional check needs a price; the desk's own interval is the
    // honest one to read it from.
    let price = 0;
    if (desired) {
      const candles = await getCandles(symbol, key.interval, undefined, undefined, 1);
      price = candles[0]?.close ?? 0;
      if (!(price > 0)) {
        symbolReport.skipped = 'no candle to price the minimum-notional check against';
        report.symbols.push(symbolReport);
        continue;
      }
    }

    const intents = planMirror({
      book: bookId,
      desired,
      actual,
      algoOrders: symbolAlgos,
      filter,
      scale,
      price,
    });

    // The WHOLE plan is recorded before anything is attempted, so a report
    // from a failed tick still shows what the mirror meant to do, not just
    // the one order it got as far as.
    for (const intent of intents) {
      symbolReport.intents.push(describeIntent(intent));
      report.totalIntents++;
    }

    for (const intent of intents) {
      const line = describeIntent(intent);
      log(`  ${dryRun ? 'would' : 'sending'}: ${line}`);

      if (dryRun || intent.kind === 'skip') continue;

      try {
        await sendIntent(client, intent);
        symbolReport.sent++;
        report.totalSent++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        symbolReport.failed++;
        symbolReport.errors.push(`${intent.kind}: ${message}`);
        report.totalFailed++;
        log(`  FAILED ${intent.kind} on ${symbol}: ${message}`);
        // Stop at the first failure on this symbol: the later intents assume
        // the earlier ones landed (a stop sized to a position that never
        // opened would be wrong), and the next tick re-plans from scratch.
        break;
      }
    }

    report.symbols.push(symbolReport);
  }

  return report;
}

/** A short human summary of a tick, for a log line or a cron response. */
export function summariseMirror(report: MirrorReport): string {
  if (report.haltReason) return `mirror ${report.book} HALTED: ${report.haltReason}`;
  const mode = report.dryRun ? 'dry run' : 'live';
  const parts = [
    `mirror ${report.book} (${mode})`,
    `${report.totalIntents} intents`,
    report.dryRun ? 'none sent' : `${report.totalSent} sent, ${report.totalFailed} failed`,
  ];
  if (report.strayPositions.length > 0) parts.push(`stray: ${report.strayPositions.join(', ')}`);
  return parts.join(', ');
}
