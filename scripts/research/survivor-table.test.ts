// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { formatSurvivorTable, loadReports, parseArgs } from './survivor-table';
import type { PhaseSurvivorTable } from './report-schema';

describe('survivor-table parseArgs', () => {
  it('splits --reports, defaults fdr-q to 0.1, and takes --out', () => {
    expect(parseArgs(['--reports', 'a.json,b.json'])).toEqual({ reports: ['a.json', 'b.json'], fdrQ: 0.1, out: undefined });
    expect(parseArgs(['--reports', 'a.json', '--fdr-q', '0.05', '--out', 'x.json']).fdrQ).toBe(0.05);
  });

  it('throws without --reports and on a bad q', () => {
    expect(() => parseArgs([])).toThrow(/--reports/);
    expect(() => parseArgs(['--reports', 'a', '--fdr-q', '2'])).toThrow(/fdr-q/);
  });

  it('rejects an unknown flag rather than absorbing it as a no-op', () => {
    expect(() => parseArgs(['--reports', 'a', '--fdr', '0.1'])).toThrow('Unknown flag --fdr');
  });
});

describe('loadReports', () => {
  it('rejects a file that fails schema validation, naming it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'survivor-table-'));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ schemaVersion: 2 }));
    await expect(loadReports([bad])).rejects.toThrow(/bad\.json/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('formatSurvivorTable', () => {
  const table: PhaseSurvivorTable = {
    minAbsIc: 0.02,
    minT: 3.15,
    fdrQ: 0.1,
    cells: 12,
    rejectedCells: 4,
    perInterval: [{ interval: '1h', taskId: 'pB', survivors: 1, factors: 3 }],
    rows: [
      { interval: '1h', taskId: 'pB', factor: 'raw.a', category: 'raw', sign: 1, horizonsPassing: [1, 2, 4, 8, 16, 32, 48], quarterAgreement: 1, symbolAgreement: 1, survivor: true, reasons: [] },
      { interval: '1h', taskId: 'pB', factor: 'raw.b', category: 'raw', sign: 0, horizonsPassing: [], quarterAgreement: 0, symbolAgreement: 0, survivor: false, reasons: ['x'] },
      { interval: '1h', taskId: 'pB', factor: 'raw.c', category: 'raw', sign: -1, horizonsPassing: [1], quarterAgreement: 0.5, symbolAgreement: 0.9, survivor: false, reasons: ['only 1 horizon(s) passed', 'quarter agreement 0.50 is below the 0.6 minimum'], fdrExcludedHorizons: [4] },
    ],
  };

  it('prints the rule, the cell count and one line per interval, then survivor rows only', () => {
    const text = formatSurvivorTable(table);
    expect(text).toContain('|t| >= 3.15');
    expect(text).toContain('FDR q 0.1');
    expect(text).toContain('cells 12');
    expect(text).toContain('1h  pB');
    expect(text).toContain('raw.a');
    expect(text).not.toContain('raw.b');
  });

  // The widths item D fixes: header and row must pad to the same numbers, so
  // every cell starts at its own column's offset.
  const WIDTHS = [6, 12, 30, 6, 20, 10, 10];
  const LABELS = ['iv', 'taskId', 'factor', 'sign', 'horizons', 'quarters', 'symbols'];
  const offsetOf = (column: number) => WIDTHS.slice(0, column).reduce((s, w) => s + w, 0);

  it('prints taskId as the second column, with header widths equal to row widths', () => {
    const lines = formatSurvivorTable(table).split('\n');
    const header = lines.find((l) => l.startsWith('iv'))!;
    const row = lines.find((l) => l.includes('raw.a'))!;
    expect(header).toBe(LABELS.map((l, i) => l.padEnd(WIDTHS[i])).join('').trimEnd());
    expect(row.slice(offsetOf(0), offsetOf(0) + 2)).toBe('1h');
    expect(row.slice(offsetOf(1), offsetOf(1) + 2)).toBe('pB');
    expect(row.slice(offsetOf(2), offsetOf(2) + 5)).toBe('raw.a');
    expect(row.slice(offsetOf(3), offsetOf(3) + 1)).toBe('+');
  });

  it('keeps a seven-horizon list inside its own column', () => {
    const row = formatSurvivorTable(table).split('\n').find((l) => l.includes('raw.a'))!;
    expect(row.slice(offsetOf(4), offsetOf(4) + 16)).toBe('1,2,4,8,16,32,48');
    expect(row.slice(offsetOf(5), offsetOf(5) + 4)).toBe('1.00');
    expect(row.slice(offsetOf(6), offsetOf(6) + 4)).toBe('1.00');
  });

  it('keeps a real taskId whole and still off the next cell', () => {
    const long = 'factor-ic-15m-202609261234';
    const withLongId: PhaseSurvivorTable = {
      ...table,
      rows: [{ ...table.rows[0], taskId: long }],
    };
    const row = formatSurvivorTable(withLongId).split('\n').find((l) => l.includes('raw.a'))!;
    expect(row).toContain(long);
    expect(row).toContain(`${long} raw.a`);
  });

  it('lists a near miss with its reasons, and leaves a null row out', () => {
    const text = formatSurvivorTable(table);
    const section = text.slice(text.indexOf('near misses'));
    expect(text).toContain('near misses (cleared |ic| and |t|, failed the FDR or a consistency leg):');
    expect(section).toContain('raw.c');
    expect(section).toContain('only 1 horizon(s) passed; quarter agreement 0.50 is below the 0.6 minimum');
    expect(section).not.toContain('raw.a');
    expect(section).not.toContain('raw.b');
  });
});
