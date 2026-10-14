// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');
const TSX = join(ROOT, 'node_modules/.bin/tsx');

/**
 * The quarantined studies (SUPERSEDED / VOID, 2026-10-15): each cited line, by its number in the file as it stands,
 * and a piece of the code that line must hold, so a header can never cite a line that moved.
 */
const VOID: Record<string, [defect: string, line: number, code: string][]> = {
  'cross-sectional-harness.ts': [
    ['D03', 734, "loadCandles(datasetDir, sym, '4h'"],
    ['D03', 737, "loadCandles(datasetDir, sym, '1d'"],
    ['D04', 198, 'trials = 54'],
    ['D04', 259, 'const trialVariance = 0.1 / barsPerYear;'],
    ['D05', 649, "'allow-lockbox': { type: 'boolean', default: false }"],
    ['D24', 442, 'Find last settled funding rate at or before tNext'],
    ['D24', 477, 'if (snapshots.length < 5) continue;'],
    ['D24', 557, 'if (stopped) {'],
    ['D24', 571, 'const symbolReturn = barOpen > 0'],
    ['D24', 573, 'nextCurrentPositions.set(sym, weight);'],
  ],
  'cross-sectional-permutation.ts': [
    ['D02', 243, 'const prevBar = prevMap?.get(sym);'],
    ['D02', 293, 'const numBlocks = Math.ceil(n / blockSize);'],
    ['D02', 427, 'const strategyConfig = {'],
    ['D02', 459, 'runSimulation(permutedBars, fundingBySymbol'],
    ['D02', 533, 'p(Gross Sharpe >= Real)'],
    ['D02', 536, 'p(Net Maker Return >= Real)'],
    ['D03', 421, "loadCandles(datasetDir, sym, '4h'"],
    ['D05', 399, "'allow-lockbox': { type: 'boolean', default: false }"],
  ],
  'cross-sectional-walkforward.ts': [
    ['D01', 424, 'for (let m = 1; m <= permutations; m++) {'],
    ['D01', 425, 'Generate synthetic noise Sharpe'],
    ['D01', 432, 'nullMakerReturns.push'],
    ['D01', 459, 'pValues: {'],
    ['D01', 491, '})),'],
    ['D03', 375, "loadCandles(datasetDir, sym, '4h'"],
    ['D05', 348, "'allow-lockbox': { type: 'boolean', default: false }"],
  ],
};

describe('the void cross-sectional studies, quarantined 2026-10-15', () => {
  for (const [file, anchors] of Object.entries(VOID)) {
    const path = join(__dirname, file);

    it(`${file}: main() prints the pointer to the re-validation and exits 2 before it reads anything`, () => {
      const r = spawnSync(TSX, [path, '--dataset-dir', join(ROOT, 'no-such-dataset'), '--allow-lockbox'], { cwd: ROOT, encoding: 'utf8' });
      // stack frames of the child's errors are dropped: Vitest would try to source-map them inside a failure message
      const stderr = r.stderr.split('\n').filter((l) => !/^\s+at /.test(l)).join('\n');
      expect(r.status, stderr).toBe(2);
      expect(stderr).toContain('SUPERSEDED / VOID (2026-10-15)');
      expect(stderr).toContain(file);
      expect(stderr).toContain('scripts/research/rv-revalidation.ts');
      expect(stderr).not.toMatch(/ENOENT|no-such-dataset/);
      expect(r.stdout).toBe('');
    });

    it(`${file}: the header opens the file and cites each defect at the line that holds it`, () => {
      const text = readFileSync(path, 'utf8');
      const lines = text.split('\n');
      expect(lines[1]).toMatch(/^ \* SUPERSEDED \/ VOID \(2026-10-15\)\./);
      const header = text.slice(0, text.indexOf('*/'));
      expect(header).toContain('scripts/research/rv-revalidation.ts');
      // the lines the header cites, alone ("line 198") or as a range ("lines 442-450")
      const ranges = [...header.matchAll(/\b(\d{3})(?:-(\d{3}))?\b/g)].map((m) => [Number(m[1]), Number(m[2] ?? m[1])]);
      for (const [defect, line, code] of anchors) {
        expect(header, `${defect} line ${line}`).toContain(defect);
        expect(ranges.some(([lo, hi]) => line >= lo && line <= hi), `${file}: line ${line} (${defect}) is not cited`).toBe(true);
        expect(lines[line - 1], `${file}:${line}`).toContain(code);
      }
    });
  }
});
