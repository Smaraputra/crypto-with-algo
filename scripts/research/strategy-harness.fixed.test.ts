// @vitest-environment node
//
// The harness's fixed-evaluation mode (legends phase) end to end on a
// synthetic dataset: evaluation from each symbol's perp listing, funding from
// the per-settlement series with the snapshot fallback, perp prices spliced
// onto spot warmup with a gap carried forward, calendar windows by exit time,
// one benchmark per symbol, and the report fields the phase-level script reads.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LOCKBOX_START_ISO,
  datasetHashOf,
  sha256File,
  writeJsonlGz,
  type CandleRow,
  type DatasetKind,
  type DatasetManifest,
  type FundingRow,
  type ManifestFile,
  type PerpCandleRow,
  type SnapshotRow,
} from './dataset-format';
import { validateStrategyReport } from './report-schema';
import { parseArgs, runStrategyHarness, splicePerpCandles } from './strategy-harness';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.UTC(2025, 0, 1);
const COUNT = 1500;
const LISTING = START + 10 * DAY;
const ARCHIVE_FROM = START + 15 * DAY;
const PERP_FROM = START + 30 * DAY;

function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
}

function candleRows(seed: number): CandleRow[] {
  const next = lcg(seed);
  let price = 100;
  return Array.from({ length: COUNT }, (_, i) => {
    price *= 1 + Math.sin(i / 7) * 0.004 + (next() - 0.5) * 0.02;
    const open = price * (1 + (next() - 0.5) * 0.002);
    return {
      t: START + i * HOUR,
      o: open,
      h: Math.max(open, price) * (1 + next() * 0.006),
      l: Math.min(open, price) * (1 - next() * 0.006),
      c: price,
      v: 1000,
      tbv: 500,
    };
  });
}

function snapshot(t: number, rate: number | null): SnapshotRow {
  return {
    t,
    fundingRate: rate === null ? null : { rate, markPrice: 100 },
    longShortRatio: null,
    openInterest: null,
    fearGreed: null,
    newsSentiment: null,
  } as unknown as SnapshotRow;
}

async function buildDataset(dir: string): Promise<DatasetManifest> {
  const files: ManifestFile[] = [];
  const add = async (path: string, kind: DatasetKind, symbol: string, interval: string, rows: Array<{ t: number }>) => {
    await writeJsonlGz(join(dir, path), rows);
    files.push({
      path,
      kind,
      symbol,
      interval,
      rowCount: rows.length,
      startMs: rows[0]?.t ?? null,
      endMs: rows[rows.length - 1]?.t ?? null,
      sha256: await sha256File(join(dir, path)),
    });
  };
  for (const [k, symbol] of SYMBOLS.entries()) {
    const spot = candleRows(4242 + k * 1000);
    await add(`candles/${symbol}/1h.jsonl.gz`, 'candles', symbol, '1h', spot);
    await add(
      `snapshots/${symbol}/1h.jsonl.gz`,
      'snapshots',
      symbol,
      '1h',
      spot.map((r) => snapshot(r.t, 0.0001))
    );
    const days = Math.ceil((COUNT * HOUR) / DAY);
    await add(
      `snapshots/${symbol}/1d.jsonl.gz`,
      'snapshots',
      symbol,
      '1d',
      Array.from({ length: days }, (_, d) => snapshot(START + d * DAY, START + d * DAY >= LISTING ? 0.0001 : null))
    );
    await add(
      `snapshots/${symbol}/4h.jsonl.gz`,
      'snapshots',
      symbol,
      '4h',
      Array.from({ length: days * 6 }, (_, j) => snapshot(START + j * 4 * HOUR, 0.0002))
    );
    const settlements: FundingRow[] = [];
    for (let t = ARCHIVE_FROM; t < START + COUNT * HOUR; t += 8 * HOUR) settlements.push({ t, rate: 0.0001, intervalHours: 8 });
    await add(`funding/${symbol}/settlements.jsonl.gz`, 'funding', symbol, 'settlements', settlements);
    // Perp bars from PERP_FROM, three missing in the middle.
    const perp: PerpCandleRow[] = spot
      .filter((r) => r.t >= PERP_FROM)
      .filter((r) => r.t < PERP_FROM + 100 * HOUR || r.t >= PERP_FROM + 103 * HOUR)
      .map((r) => ({ ...r, o: r.o * 1.0005, h: r.h * 1.0005, l: r.l * 1.0005, c: r.c * 1.0005, qv: 0, n: 0 }));
    await add(`perp/${symbol}/1h.jsonl.gz`, 'perp', symbol, '1h', perp);
  }
  const manifest: DatasetManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    commit: 'test-fixture',
    lockboxStart: LOCKBOX_START_ISO,
    symbols: SYMBOLS,
    intervals: ['1h', '4h', '1d'],
    files,
    datasetHash: datasetHashOf(files),
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

describe('strategy-harness fixed-evaluation mode', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'strategy-harness-fixed-'));
    await buildDataset(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const baseFlags = (out: string) => [
    '--family', 'bollinger-breakout',
    '--interval', '1h',
    '--dataset-dir', dir,
    '--fixed-eval',
    '--start-at-listing',
    '--funding-settlements',
    '--windows', '3',
    '--bootstrap-n', '50',
    '--benchmark-n', '10',
    '--out', out,
  ];

  it('evaluates from the listing with settlement funding and writes the trades and bookkeeping', async () => {
    const report = await runStrategyHarness(parseArgs(baseFlags(join(dir, 'r.json'))));
    expect(validateStrategyReport(report).ok).toBe(true);
    expect(report.gates.map((g) => g.name)).toHaveLength(8);
    const fixed = report.fixedEvaluation!;
    expect(fixed).toMatchObject({ startAtListing: true, fundingSource: 'settlements', price: 'spot', perpFrom: null });
    for (const s of report.perSymbol) {
      const info = fixed.perSymbol[s.symbol];
      expect(info.listingDay).toBe(LISTING);
      // The 1h style's warmup ends before the listing, so evaluation starts at the listing itself.
      expect(info.evalStartTime).toBe(LISTING);
      expect(info.fallbackSettlements).toBe(15); // 5 days x 3 settlements before the archive
      expect(s.windows).toHaveLength(3);
      const trades = s.windows.flatMap((w) => w.trades ?? []);
      expect(trades.length).toBe(s.pooledOos.trades);
      expect(trades.length).toBeGreaterThan(0);
      for (const t of trades) expect(t.entryTime).toBeGreaterThanOrEqual(LISTING);
      expect(s.windows[0].benchmark).not.toBeNull();
      expect(s.windows.slice(1).every((w) => w.benchmark === null)).toBe(true);
      expect(s.windows.every((w) => w.isCells.length === 0)).toBe(true);
      // Exits fall in the window they are assigned to.
      for (const w of s.windows) {
        for (const t of w.trades ?? []) expect(t.exitTime).toBeGreaterThanOrEqual(s.windows[0].trades![0]?.exitTime ?? 0);
      }
    }
  });

  it('prices on perp bars from --perp-from with spot warmup, carrying a missing bar forward', async () => {
    const report = await runStrategyHarness(
      parseArgs([...baseFlags(join(dir, 'p.json')), '--price', 'perp', '--perp-from', new Date(PERP_FROM).toISOString()])
    );
    expect(report.fixedEvaluation!.price).toBe('perp');
    for (const s of report.perSymbol) expect(report.fixedEvaluation!.perSymbol[s.symbol].perpFilledBars).toBe(3);
  });

  it('honours --eval-from as a later start', async () => {
    const evalFrom = START + 40 * DAY;
    const report = await runStrategyHarness(
      parseArgs([...baseFlags(join(dir, 'e.json')), '--eval-from', new Date(evalFrom).toISOString()])
    );
    for (const s of report.perSymbol) {
      expect(report.fixedEvaluation!.perSymbol[s.symbol].evalStartTime).toBe(evalFrom);
      for (const t of s.windows.flatMap((w) => w.trades ?? [])) expect(t.entryTime).toBeGreaterThanOrEqual(evalFrom);
    }
  });

  it('refuses the fixed-evaluation flags without --fixed-eval, and a multi-cell family with it', async () => {
    await expect(
      runStrategyHarness(
        parseArgs(['--family', 'bollinger-breakout', '--interval', '1h', '--dataset-dir', dir, '--start-at-listing'])
      )
    ).rejects.toThrow(/need --fixed-eval/);
    await expect(
      runStrategyHarness(parseArgs(['--family', 'sweep-reclaim', '--interval', '1h', '--dataset-dir', dir, '--fixed-eval']))
    ).rejects.toThrow(/needs one cell/);
    expect(() => parseArgs(['--family', 'control', '--interval', '1h', '--price', 'mark'])).toThrow(/--price/);
  });
});

describe('splicePerpCandles', () => {
  it('joins spot before the splice to perp from it and fills a gap with the last close', () => {
    const row = (t: number, c: number) => ({ t, o: c, h: c, l: c, c, v: 1, tbv: null });
    const spot = [0, 1, 2, 3].map((i) => row(i * HOUR, 10 + i));
    const perp = [2, 5].map((i) => ({ ...row(i * HOUR, 20 + i), qv: 0, n: 0 }));
    const { candles, filled } = splicePerpCandles(spot, perp, 2 * HOUR, HOUR);
    expect(candles.map((c) => c.close)).toEqual([10, 11, 22, 22, 22, 25]);
    expect(filled).toBe(2);
  });
});
