// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeJsonlGz } from './dataset-format';
import { buildCarryInput, formatCarry, parseArgs, runCarry } from './carry-harness';

const HOUR = 3_600_000;
const START = Date.UTC(2022, 0, 1);
const END = Date.UTC(2026, 6, 1);

/** Flat prices from 2022 to mid-2026 and a funding rate per symbol, every 8h. */
async function writeDataset(dir: string, rates: Record<string, number>) {
  for (const [symbol, rate] of Object.entries(rates)) {
    const candles = [];
    for (let t = START; t < END; t += HOUR) candles.push({ t, o: 100, h: 100, l: 100, c: 100, v: 1, tbv: null });
    await writeJsonlGz(join(dir, 'candles', symbol, '1h.jsonl.gz'), candles);
    await writeJsonlGz(
      join(dir, 'perp', symbol, '1h.jsonl.gz'),
      candles.map((c) => ({ t: c.t, o: 100, h: 100, l: 100, c: 100, v: 1, qv: 100, n: 1, tbv: null }))
    );
    const funding = [];
    for (let t = START; t < END; t += 8 * HOUR) funding.push({ t, rate, intervalHours: 8 });
    await writeJsonlGz(join(dir, 'funding', symbol, 'settlements.jsonl.gz'), funding);
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ datasetHash: 'f'.repeat(64), files: [] }));
}

describe('parseArgs', () => {
  it('defaults to the research dataset and the ten signal symbols', () => {
    const args = parseArgs([]);
    expect(args.datasetDir).toBe('data/research');
    expect(args.symbols).toHaveLength(10);
  });
  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--fees', 'maker'])).toThrow(/Unknown flag --fees/);
  });
});

describe('buildCarryInput', () => {
  it('keeps only the bars spot and perp share', () => {
    const input = buildCarryInput(
      'BTCUSDT',
      [
        { t: 0, o: 1, h: 1, l: 1, c: 1, v: 1, tbv: null },
        { t: HOUR, o: 1, h: 1, l: 1, c: 1, v: 1, tbv: null },
      ],
      [{ t: HOUR, o: 2, h: 3, l: 1, c: 2, v: 1, qv: 1, n: 1, tbv: null } as never],
      [{ t: 0, rate: 0.0001, intervalHours: 8 }]
    );
    expect(input.t).toEqual([HOUR]);
    expect(input.perpHigh).toEqual([3]);
  });
});

describe('runCarry, end to end on a synthetic dataset', () => {
  let paying: string;
  let flat: string;
  beforeAll(async () => {
    paying = mkdtempSync(join(tmpdir(), 'carry-pay-'));
    flat = mkdtempSync(join(tmpdir(), 'carry-flat-'));
    await writeDataset(paying, { AAAUSDT: 0.0002, BBBUSDT: 0.0002 }); // 21.9% a year
    await writeDataset(flat, { AAAUSDT: 0, BBBUSDT: 0 });
  }, 60_000);
  afterAll(() => {
    rmSync(paying, { recursive: true, force: true });
    rmSync(flat, { recursive: true, force: true });
  });

  it('passes a book that collects 21.9% a year of funding, and validates its report', () => {
    const report = runCarry({ datasetDir: paying, symbols: ['AAAUSDT', 'BBBUSDT'], out: '/dev/null', taskId: 't' });
    expect(report.windows).toHaveLength(7);
    // 0.0002 x 3 x 365 = 21.9%, less one round trip per six-month window.
    expect(report.r0.stat.annual!).toBeGreaterThan(0.2);
    expect(report.r0.stat.annual!).toBeLessThan(0.219);
    expect(report.r0.killed).toBe(false);
    expect(report.killCriterionFires).toBe(false);
    expect(report.lockboxApplied).toBe(true);
    expect(formatCarry(report)).toContain('KILL CRITERION FIRES: false');
  }, 120_000);

  it('fires the criterion on a book with no funding to collect, only costs', () => {
    const report = runCarry({ datasetDir: flat, symbols: ['AAAUSDT', 'BBBUSDT'], out: '/dev/null', taskId: 't' });
    expect(report.r0.stat.annual!).toBeLessThan(0);
    expect(report.killCriterionFires).toBe(true);
  }, 120_000);
});
