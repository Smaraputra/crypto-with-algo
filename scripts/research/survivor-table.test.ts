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
  it('prints the rule, the cell count and one line per interval, then survivor rows only', () => {
    const table: PhaseSurvivorTable = {
      minAbsIc: 0.02,
      minT: 3.15,
      fdrQ: 0.1,
      cells: 12,
      rejectedCells: 4,
      perInterval: [{ interval: '1h', taskId: 'pB', survivors: 1, factors: 3 }],
      rows: [
        { interval: '1h', factor: 'raw.a', category: 'raw', sign: 1, horizonsPassing: [1, 2], quarterAgreement: 1, symbolAgreement: 1, survivor: true, reasons: [] },
        { interval: '1h', factor: 'raw.b', category: 'raw', sign: 0, horizonsPassing: [], quarterAgreement: 0, symbolAgreement: 0, survivor: false, reasons: ['x'], fdrExcludedHorizons: [4] },
      ],
    };
    const text = formatSurvivorTable(table);
    expect(text).toContain('|t| >= 3.15');
    expect(text).toContain('FDR q 0.1');
    expect(text).toContain('cells 12');
    expect(text).toContain('1h  pB');
    expect(text).toContain('raw.a');
    expect(text).not.toContain('raw.b');
  });
});
