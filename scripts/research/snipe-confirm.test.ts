import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_SYMBOLS, writeSyntheticCache } from './snipe-cache-fixture';
import { parseArgs, runSnipeConfirm, type SnipeConfirmationReport } from './snipe-confirm';
import { runSnipeScan, type SnipeDiscoveryReport } from './snipe-scan';

const DRAWS = 100;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'snipe-confirm-'));
  dirs.push(d);
  return d;
};
const quiet = () => undefined;

let dir: string;
let discoveryPath: string;
let discovery: SnipeDiscoveryReport;
let confirmation: SnipeConfirmationReport;

beforeAll(() => {
  dir = tmp();
  writeSyntheticCache({ dir, plant: { column: 'raw.ret1', share: 0.15 } });
  discoveryPath = join(dir, 'discovery.json');
  discovery = runSnipeScan(
    { cacheDir: dir, timeframes: ['scalp', 'intraday'], draws: 20, symbols: FIXTURE_SYMBOLS, out: discoveryPath },
    quiet
  ) as SnipeDiscoveryReport;
  confirmation = runSnipeConfirm(
    { cacheDir: dir, discovery: discoveryPath, draws: DRAWS, symbols: FIXTURE_SYMBOLS, out: join(dir, 'confirmation.json') },
    quiet
  ) as SnipeConfirmationReport;
}, 600_000);

afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('snipe-confirm', () => {
  it('confirms a planted edge', () => {
    expect(discovery.verdict).toBe('SELECTED');
    expect(confirmation.reportKind).toBe('snipe-confirmation');
    expect(confirmation.m).toBe(discovery.selected.length);
    expect(confirmation.alphaPerCell).toBeCloseTo(0.05 / confirmation.m, 12);
    expect(confirmation.draws).toBe(DRAWS);
    expect(confirmation.cells).toHaveLength(confirmation.m);
    const hit = confirmation.cells.find((c) => c.cell.column === 'raw.ret1');
    expect(hit).toBeDefined();
    expect(hit!.direction).toBe(1);
    expect(hit!.pass).toBe(true);
    expect(confirmation.verdict).toBe('EDGE_BEFORE_COSTS');
    expect(confirmation.slice.start).toBe('2025-01-01T00:00:00Z');
    expect(confirmation.discoveryReportSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(confirmation).sort()).toEqual(
      [
        'reportKind',
        'schemaVersion',
        'datasetManifestHash',
        'gitCommit',
        'computedAt',
        'slice',
        'draws',
        'seed',
        'minShiftDays',
        'symbols',
        'discoveryReportSha256',
        'm',
        'alphaPerCell',
        'sanity',
        'cells',
        'verdict',
      ].sort()
    );
    expect(JSON.parse(readFileSync(join(dir, 'confirmation.json'), 'utf8')).verdict).toBe('EDGE_BEFORE_COSTS');
  });

  it('--cell reproduces the confirmation report entry exactly', () => {
    const entry = confirmation.cells[0];
    const lines: string[] = [];
    runSnipeConfirm(
      { cacheDir: dir, discovery: discoveryPath, draws: DRAWS, symbols: FIXTURE_SYMBOLS, cell: entry.cell },
      (l) => lines.push(l)
    );
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(JSON.parse(JSON.stringify(entry.report)));
  });

  it('refuses a NULL discovery report', () => {
    const nullPath = join(dir, 'null.json');
    writeFileSync(nullPath, JSON.stringify({ ...discovery, selected: [], verdict: 'NULL' }));
    expect(() =>
      runSnipeConfirm({ cacheDir: dir, discovery: nullPath, draws: DRAWS, symbols: FIXTURE_SYMBOLS, out: 'x' }, quiet)
    ).toThrow(/NULL/);
  });

  it('refuses a discovery report with a different dataset hash', () => {
    const p = join(dir, 'other-hash.json');
    writeFileSync(p, JSON.stringify({ ...discovery, datasetManifestHash: 'something-else' }));
    expect(() =>
      runSnipeConfirm({ cacheDir: dir, discovery: p, draws: DRAWS, symbols: FIXTURE_SYMBOLS, out: 'x' }, quiet)
    ).toThrow(/differs/);
  });

  it('parses flags with the confirmation default draws', () => {
    const a = parseArgs(['--cache-dir', 'c', '--discovery', 'd.json', '--out', 'o.json']);
    expect(a.draws).toBe(1000);
    expect(() => parseArgs(['--cache-dir', 'c', '--out', 'o'])).toThrow(/--discovery/);
  });
});
