/**
 * Runs one tick of the demo mirror.
 *
 * DRY RUN unless `DEMO_EXECUTION_ENABLED=true` or `--execute` is passed. A dry
 * run reads the desk and the venue, prints the orders it would send, and sends
 * nothing: the client it builds refuses writes outright, so a bug cannot place
 * an order on a tick that was meant to observe.
 *
 * Run it on the VPS, where Binance is reachable (the home ISP blocks it):
 *
 *   cd /opt/sites/crypto
 *   docker run --rm --env-file .env --network crypto_crypto-internal \
 *     crypto-ops:<tag> npx tsx scripts/ops/demo-mirror.ts
 *
 * or, for the dry run only, with the host's own node and no container:
 *
 *   set -a; . ./.env; set +a
 *   npx tsx scripts/ops/demo-mirror.ts
 *
 * Flags:
 *   --book <style:interval>  override DEMO_BOOK
 *   --execute                place real orders on the DEMO venue
 *   --json                   print the report as JSON
 *   --mongo-uri <uri>        connect here instead of MONGODB_URI
 */
import { connectDB } from '@/lib/mongodb';
import { runMirror, summariseMirror, type MirrorReport } from '@/lib/execution/run-mirror';

export interface ParsedArgs {
  book: string | null;
  execute: boolean;
  json: boolean;
  mongoUri: string | null;
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let book: string | null = null;
  let execute = false;
  let json = false;
  let mongoUri: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--book':
        book = nextValue(argv, ++i, '--book');
        break;
      case '--execute':
        execute = true;
        break;
      case '--json':
        json = true;
        break;
      case '--mongo-uri':
        mongoUri = nextValue(argv, ++i, '--mongo-uri');
        break;
      default:
        throw new Error(`Unknown flag "${argv[i]}"`);
    }
  }

  return { book, execute, json, mongoUri };
}

export function formatReport(report: MirrorReport): string {
  const lines: string[] = [summariseMirror(report)];
  if (report.haltReason) return lines.join('\n');

  lines.push(
    `  balance ${report.balance} USDT, scale ${report.scale?.toPrecision(4)}, one-way ${report.oneWay}, canTrade ${report.canTrade}`
  );
  for (const symbol of report.symbols) {
    if (symbol.skipped) {
      lines.push(`  ${symbol.symbol}: skipped, ${symbol.skipped}`);
      continue;
    }
    if (symbol.intents.length === 0) continue;
    lines.push(`  ${symbol.symbol}:`);
    for (const intent of symbol.intents) lines.push(`    ${intent}`);
    if (symbol.errors.length > 0) {
      for (const error of symbol.errors) lines.push(`    ERROR ${error}`);
    }
  }
  if (report.strayPositions.length > 0) {
    lines.push(`  stray venue positions outside the signal set: ${report.strayPositions.join(', ')}`);
  }
  if (report.dryRun) {
    lines.push('');
    lines.push('DRY RUN: nothing was sent. Pass --execute, or set DEMO_EXECUTION_ENABLED=true, to place these.');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.mongoUri) process.env.MONGODB_URI = args.mongoUri;
    await connectDB();
    const report = await runMirror({
      ...(args.book ? { book: args.book } : {}),
      ...(args.execute ? { execute: true } : {}),
    });
    console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
    process.exit(report.haltReason ? 1 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (require.main === module) {
  void main();
}
