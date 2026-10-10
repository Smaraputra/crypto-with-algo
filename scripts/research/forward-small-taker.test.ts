// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  datasetHashOf,
  LOCKBOX_START_ISO,
  sha256File,
  writeJsonlGz,
  type CandleRow,
  type DatasetManifest,
  type FlowRow,
  type HtfRow,
  type ManifestFile,
  type PerpCandleRow,
} from './dataset-format';
import { FORWARD_ALPHA, FORWARD_B_BREAKEVEN_IC, FORWARD_NULL, FORWARD_WINDOW } from './forward-test';
import {
  breakevenLine,
  forwardSmallTakerPass,
  negativeSymbolCount,
  negativeZ,
  parseForwardSmallTakerArgs,
  runForwardSmallTaker,
} from './forward-small-taker';

describe('forward-small-taker pure parts', () => {
  it('parses flags with the locked draw default', () => {
    const a = parseForwardSmallTakerArgs(['--dataset-dir', 'd', '--out', 'o.json']);
    expect(a).toEqual({ datasetDir: 'd', out: 'o.json', draws: FORWARD_NULL.draws });
    expect(parseForwardSmallTakerArgs(['--dataset-dir', 'd', '--out', 'o', '--draws', '50']).draws).toBe(50);
    expect(() => parseForwardSmallTakerArgs(['--out', 'o'])).toThrow(/--dataset-dir/);
    expect(() => parseForwardSmallTakerArgs(['--dataset-dir', 'd'])).toThrow(/--out/);
    expect(() => parseForwardSmallTakerArgs(['--dataset-dir', 'd', '--out', 'o', '--bad', 'x'])).toThrow(/Unknown flag/);
  });

  it('negativeZ inflates the null sd by 1.25 and takes the lower tail', () => {
    const { z, p } = negativeZ(-0.05, 0.001, 0.02);
    expect(z).toBeCloseTo((-0.05 - 0.001) / (1.25 * 0.02), 12);
    expect(p).toBeCloseTo(0.0206, 3); // Phi(-2.04)
    expect(negativeZ(0.05, 0, 0.02).p).toBeCloseTo(0.97725, 4);
    expect(negativeZ(0, 0, 0.02).p).toBeCloseTo(0.5, 9);
    const bad = negativeZ(-0.1, 0, 0);
    expect(bad.z).toBeNaN();
    expect(bad.p).toBe(1);
    expect(negativeZ(NaN, 0, 1).p).toBe(1);
  });

  it('counts negative symbols and ignores null and NaN', () => {
    expect(negativeSymbolCount([-0.1, -0.2, 0, 0.1, null, NaN, undefined, -1e-9])).toBe(3);
  });

  it('applies the pass rule strictly: IC < 0, both p < alpha, at least 7 symbols', () => {
    const ok = { pooledIc: -0.02, empiricalPLow: 0.005, zP: 0.01, negativeSymbols: 7 };
    expect(forwardSmallTakerPass(ok)).toBe(true);
    expect(forwardSmallTakerPass({ ...ok, pooledIc: 0 })).toBe(false);
    expect(forwardSmallTakerPass({ ...ok, pooledIc: 0.01 })).toBe(false);
    expect(forwardSmallTakerPass({ ...ok, empiricalPLow: FORWARD_ALPHA })).toBe(false);
    expect(forwardSmallTakerPass({ ...ok, zP: FORWARD_ALPHA })).toBe(false);
    expect(forwardSmallTakerPass({ ...ok, zP: 0.02 })).toBe(false);
    expect(forwardSmallTakerPass({ ...ok, negativeSymbols: 6 })).toBe(false);
    expect(forwardSmallTakerPass({ ...ok, pooledIc: NaN })).toBe(false);
    expect(forwardSmallTakerPass({ ...ok, empiricalPLow: NaN })).toBe(false);
  });

  it('reports |IC| against the header breakevens', () => {
    expect(breakevenLine(-0.0329 - 1e-6)).toMatchObject({ aboveTaker: true, aboveMaker: true });
    expect(breakevenLine(-0.01)).toMatchObject({ aboveTaker: false, aboveMaker: true, absIc: 0.01 });
    expect(breakevenLine(0.005)).toMatchObject({ aboveTaker: false, aboveMaker: false });
    expect(breakevenLine(-0.02)).toMatchObject(FORWARD_B_BREAKEVEN_IC);
  });
});

describe('forward-small-taker on a synthetic flow dataset', { timeout: 300_000 }, () => {
  const HOUR = 3_600_000;
  const FIVE = 300_000;
  const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  // 2026-06-20 to 2026-10-10 hourly, spanning the lockbox start and the whole forward window.
  const START = Date.UTC(2026, 5, 20);
  const BARS = Math.round((Date.UTC(2026, 9, 10) - START) / HOUR);
  let dir: string;

  function rng(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    };
  }

  async function build(dirPath: string, flowSign: number): Promise<void> {
    const files: ManifestFile[] = [];
    const add = async (kind: ManifestFile['kind'], symbol: string, interval: string, rows: { t: number }[]) => {
      const rel = `${kind}/${symbol}/${interval}.jsonl.gz`;
      mkdirSync(dirname(join(dirPath, rel)), { recursive: true });
      await writeJsonlGz(join(dirPath, rel), rows);
      files.push({
        path: rel,
        kind,
        symbol,
        interval,
        rowCount: rows.length,
        startMs: rows.length ? rows[0].t : null,
        endMs: rows.length ? rows[rows.length - 1].t : null,
        sha256: await sha256File(join(dirPath, rel)),
      });
    };
    for (const [si, symbol] of SYMBOLS.entries()) {
      const next = rng(1000 + si * 17);
      const eps: number[] = [];
      for (let i = 0; i < BARS + 3; i++) eps.push((next() - 0.5) * 0.02);
      const candles: CandleRow[] = [];
      let price = 100;
      for (let i = 0; i < BARS; i++) {
        const close = price * (1 + eps[i]);
        candles.push({
          t: START + i * HOUR,
          o: price,
          h: Math.max(price, close) * 1.001,
          l: Math.min(price, close) * 0.999,
          c: close,
          v: 1000,
          tbv: 500,
        });
        price = close;
      }
      // Small-class taker imbalance of hour i leans against the next two bars' returns when flowSign is -1.
      const flow: FlowRow[] = [];
      for (let i = 0; i < BARS; i++) {
        const lean = flowSign * (eps[i + 1] + eps[i + 2]) * 400 + (next() - 0.5) * 30;
        for (let k = 0; k < 12; k++) {
          const smallDiff = lean / 12;
          flow.push({
            t: START + i * HOUR + k * FIVE,
            trades: 100,
            aggTrades: 100,
            buyBase: 1,
            sellBase: 1,
            buyQuote: 500 + smallDiff / 2,
            sellQuote: 500 - smallDiff / 2,
            buyQuoteSmall: 200 + smallDiff / 2,
            buyQuoteMedium: 150,
            buyQuoteLarge: 150,
            sellQuoteSmall: 200 - smallDiff / 2,
            sellQuoteMedium: 150,
            sellQuoteLarge: 150,
            buyQuoteOpen10s: 10 + next(),
            sellQuoteOpen10s: 10 + next(),
            source: 'test',
          });
        }
      }
      await add('candles', symbol, '1h', candles);
      await add('snapshots', symbol, '1h', []);
      await add('htf', symbol, '1h', candles.map((c): HtfRow => ({ t: c.t, context: null })));
      await add(
        'perp',
        symbol,
        '1h',
        candles.map((c): PerpCandleRow => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c * 1.01, v: c.v, qv: c.v * c.c, n: 100, tbv: c.tbv }))
      );
      await add('flow', symbol, '5m', flow);
    }
    const manifest: DatasetManifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      commit: 'test-fixture',
      lockboxStart: LOCKBOX_START_ISO,
      symbols: SYMBOLS,
      intervals: ['1h', '5m'],
      files,
      datasetHash: datasetHashOf(files),
    };
    writeFileSync(join(dirPath, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'forward-b-'));
    await build(dir, -1);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the lockbox window, writes the floor and the report, and fails only for lack of symbols', async () => {
    const out = join(dir, 'report.json');
    const lines: string[] = [];
    const report = await runForwardSmallTaker({ datasetDir: dir, out, draws: 100 }, (l) => lines.push(l));
    const disk = JSON.parse(readFileSync(out, 'utf8'));
    expect(disk.reportKind).toBe('forward-small-taker');
    expect(disk.datasetManifestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(disk.window).toEqual(FORWARD_WINDOW);
    expect(disk.factor).toBe('raw.smallTakerImb');
    expect(disk.executionLag).toBe(1);
    expect(disk.returnSeries).toBe('perp');
    expect(disk.sdInflation).toBe(1.25);
    expect(disk.breakevenIc).toMatchObject({ taker: 0.0329, maker: 0.0082 });
    expect(JSON.parse(readFileSync(`${out}.floor.json`, 'utf8')).args.nullOnly).toBe(true);

    expect(report.observed.pooledIc).toBeLessThan(-0.1);
    expect(report.observed.perSymbol).toHaveLength(3);
    expect(report.observed.negativeSymbols).toBe(3);
    expect(report.null.validDraws).toBe(100);
    expect(report.null.gridBars).toBeGreaterThan(1500);
    expect(report.pValues.empiricalPLow).toBeCloseTo(1 / 101, 12);
    expect(report.pValues.empiricalPHigh).toBeGreaterThan(0.9);
    expect(report.pValues.zLowerTail).toBeLessThan(FORWARD_ALPHA);
    expect(report.z).toBeLessThan(-3);
    // Three symbols can never reach the 7-symbol agreement.
    expect(report.pass).toBe(false);
    expect(lines.join('\n')).toMatch(/forward-small-taker FAIL/);
  });

  it('a positive relation gives a non-negative IC and no pass', async () => {
    const posDir = mkdtempSync(join(tmpdir(), 'forward-b-pos-'));
    try {
      await build(posDir, 1);
      const report = await runForwardSmallTaker({ datasetDir: posDir, out: join(posDir, 'r.json'), draws: 50 }, () => undefined);
      expect(report.observed.pooledIc).toBeGreaterThan(0.1);
      expect(report.observed.negativeSymbols).toBe(0);
      expect(report.pValues.empiricalPLow).toBeGreaterThan(0.9);
      expect(report.pass).toBe(false);
    } finally {
      rmSync(posDir, { recursive: true, force: true });
    }
  });
});
