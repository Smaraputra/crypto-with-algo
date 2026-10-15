// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');
const TSX = join(ROOT, 'node_modules/.bin/tsx');

interface Citation {
  defect: string;
  /** The cited lines in the file as it stands. */
  now: [number, number];
  /** The same lines at 1da5742, the numbering of the locked header (rv-revalidation.ts) and the defect table. */
  then: [number, number];
  /** Code the first and the last cited line must hold. */
  start: string;
  end: string | null;
}

const c = (defect: string, now: [number, number], then: [number, number], start: string, end: string | null = null): Citation => ({ defect, now, then, start, end });

/**
 * The quarantined studies (SUPERSEDED / VOID, 2026-10-15): every citation of each header, by its line in the file as it
 * stands and at 1da5742, with the code it must hold, so a header can never cite a line that moved.
 */
const VOID: Record<string, Citation[]> = {
  'cross-sectional-harness.ts': [
    c('D03', [737, 737], [699, 699], "loadCandles(datasetDir, sym, '4h'"),
    c('D03', [740, 740], [702, 702], "loadCandles(datasetDir, sym, '1d'"),
    c('D04', [201, 201], [175, 175], 'trials = 54'),
    c('D04', [262, 262], [236, 236], 'const trialVariance = 0.1 / barsPerYear;'),
    c('D05', [652, 652], [614, 614], "'allow-lockbox': { type: 'boolean', default: false }"),
    c('D24', [445, 453], [419, 427], 'Find last settled funding rate at or before tNext', '}'),
    c('D24', [480, 488], [454, 462], 'if (snapshots.length < 5) continue;', '});'),
    c('D24', [560, 597], [534, 571], 'if (stopped) {', '}'),
    c('D24', [574, 576], [548, 550], 'const symbolReturn = barOpen > 0', 'nextCurrentPositions.set(sym, weight);'),
  ],
  'cross-sectional-permutation.ts': [
    c('D02', [428, 437], [393, 402], 'const strategyConfig = {', '};'),
    c('D02', [460, 460], [425, 425], 'runSimulation(permutedBars, fundingBySymbol'),
    c('D02', [534, 537], [499, 502], 'p(Gross Sharpe >= Real)', 'p(Net Maker Return >= Real)'),
    c('D02', [294, 318], [271, 295], 'const numBlocks = Math.ceil(n / blockSize);', '}'),
    c('D02', [244, 256], [221, 233], 'const prevBar = prevMap?.get(sym);', '});'),
    c('D03', [422, 422], [387, 387], "loadCandles(datasetDir, sym, '4h'"),
    c('D05', [400, 400], [365, 365], "'allow-lockbox': { type: 'boolean', default: false }"),
  ],
  'cross-sectional-walkforward.ts': [
    c('D01', [426, 434], [393, 401], 'for (let m = 1; m <= permutations; m++) {', 'nullMakerReturns.push'),
    c('D01', [461, 493], [428, 460], 'pValues: {', '})),'),
    c('D03', [377, 377], [344, 344], "loadCandles(datasetDir, sym, '4h'"),
    c('D05', [350, 350], [317, 317], "'allow-lockbox': { type: 'boolean', default: false }"),
  ],
};

/** Every "line N" or "lines N1-N2" of a header, with its "(M at 1da5742" or "(M1-M2 at 1da5742" when it has one. */
function citationsOf(header: string): { now: [number, number]; then: [number, number] | null }[] {
  const flat = header.replace(/\n \* {0,3}/g, ' ');
  return [...flat.matchAll(/\blines? (\d+)(?:-(\d+))?(?: \((\d+)(?:-(\d+))? at 1da5742)?/g)].map((m) => ({
    now: [Number(m[1]), Number(m[2] ?? m[1])],
    then: m[3] === undefined ? null : [Number(m[3]), Number(m[4] ?? m[3])],
  }));
}

describe('the void cross-sectional studies, quarantined 2026-10-15', () => {
  for (const [file, cites] of Object.entries(VOID)) {
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

    it(`${file}: the header cites each defect at the line that holds it, now and at 1da5742, and nothing else`, () => {
      const text = readFileSync(path, 'utf8');
      const lines = text.split('\n');
      expect(lines[1]).toMatch(/^ \* SUPERSEDED \/ VOID \(2026-10-15\)\./);
      const header = text.slice(0, text.indexOf('*/'));
      expect(header).toContain('scripts/research/rv-revalidation.ts');
      // both directions: every citation of the table is in the header, every citation of the header is in the table
      const found = citationsOf(header);
      expect(found.every((f) => f.then !== null), 'every line citation carries its 1da5742 number').toBe(true);
      const key = (x: { now: number[]; then: number[] | null }) => `${x.now.join('-')} at ${x.then?.join('-')}`;
      expect(found.map(key).sort()).toEqual(cites.map(key).sort());
      // the 1da5742 number is the current one less the lines the quarantine inserted above it: the header, then
      // the notice block before main(), then the two lines at the top of main()
      const headerLines = lines.findIndex((l) => l === ' */') + 1;
      const noticeAt = lines.findIndex((l) => l.startsWith('/** Printed by main()')) + 1;
      const mainAt = lines.findIndex((l) => l.startsWith('async function main()')) + 1;
      expect(lines[mainAt]).toContain('// Quarantined');
      expect(lines[mainAt + 1]).toBe('  exitQuarantined();');
      const inserted = (n: number) => (n < noticeAt ? headerLines : n > mainAt + 2 ? headerLines + (mainAt - noticeAt) + 2 : NaN);
      for (const x of cites) {
        expect(header, `${file}:${x.now[0]}`).toContain(x.defect);
        expect(x.now.map((n) => n - inserted(n)), `${file}:${x.now[0]}`).toEqual(x.then);
        expect(lines[x.now[0] - 1], `${file}:${x.now[0]}`).toContain(x.start);
        if (x.end !== null) expect(lines[x.now[1] - 1], `${file}:${x.now[1]}`).toContain(x.end);
      }
    });
  }
});
