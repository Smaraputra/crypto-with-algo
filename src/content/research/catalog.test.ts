// @vitest-environment node
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  LEDGER_TOTAL,
  RESEARCH_CATALOG,
  RESEARCH_FAMILIES,
  type ResearchFamily,
} from './catalog';
import { ledgerTotal } from '../../../scripts/research/ledger';
import {
  LAB_HYPOTHESES_V1,
  LAB_HYPOTHESES_V2,
  LAB_HYPOTHESES_V3,
  LAB_HYPOTHESES_V4,
} from '../../lib/signals/lab/candidates';

describe('research catalog', () => {
  it('has unique ids, valid status, steps, result, and references for every entry', () => {
    const ids = new Set<string>();
    for (const entry of RESEARCH_CATALOG) {
      expect(entry.id, 'Entry id must be a non-empty string').toBeTruthy();
      expect(ids.has(entry.id), `Duplicate entry id: ${entry.id}`).toBe(false);
      ids.add(entry.id);

      expect(entry.status, `Entry ${entry.id} missing status`).toBeTruthy();
      expect(
        entry.steps.length,
        `Entry ${entry.id} must have at least one step`
      ).toBeGreaterThanOrEqual(1);
      expect(entry.result, `Entry ${entry.id} missing result`).toBeTruthy();
      expect(
        entry.references.length,
        `Entry ${entry.id} must have at least one reference`
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it('has repo-relative tracked source and reference paths that exist and do not start with sessions/', () => {
    const cwd = process.cwd();
    for (const entry of RESEARCH_CATALOG) {
      for (const figure of entry.figures) {
        const p = figure.source.path;
        expect(path.isAbsolute(p), `Figure path must be repo-relative: ${p}`).toBe(false);
        expect(p.startsWith('sessions/'), `Figure path must not cite sessions/: ${p}`).toBe(false);
        const fullPath = path.join(cwd, p);
        expect(fs.existsSync(fullPath), `Figure path does not exist: ${p} (in entry ${entry.id})`).toBe(true);
      }

      if (entry.runs) {
        for (const run of entry.runs) {
          const p = run.source.path;
          expect(path.isAbsolute(p), `Run path must be repo-relative: ${p}`).toBe(false);
          expect(p.startsWith('sessions/'), `Run path must not cite sessions/: ${p}`).toBe(false);
          const fullPath = path.join(cwd, p);
          expect(fs.existsSync(fullPath), `Run path does not exist: ${p} (in entry ${entry.id})`).toBe(true);
        }
      }

      if (entry.trials) {
        const p = entry.trials.source.path;
        expect(path.isAbsolute(p), `Trials path must be repo-relative: ${p}`).toBe(false);
        expect(p.startsWith('sessions/'), `Trials path must not cite sessions/: ${p}`).toBe(false);
        const fullPath = path.join(cwd, p);
        expect(fs.existsSync(fullPath), `Trials path does not exist: ${p} (in entry ${entry.id})`).toBe(true);
      }

      for (const ref of entry.references) {
        if (ref.path) {
          const p = ref.path;
          expect(path.isAbsolute(p), `Reference path must be repo-relative: ${p}`).toBe(false);
          expect(p.startsWith('sessions/'), `Reference path must not cite sessions/: ${p}`).toBe(false);
          const fullPath = path.join(cwd, p);
          expect(fs.existsSync(fullPath), `Reference path does not exist: ${p} (in entry ${entry.id})`).toBe(true);
        }
      }
    }
  });

  it('proves every figure text appears at its cited line (plus or minus 2) or in its anchored section', () => {
    const cwd = process.cwd();
    const fileCache = new Map<string, string[]>();

    for (const entry of RESEARCH_CATALOG) {
      for (const figure of entry.figures) {
        const filePath = path.join(cwd, figure.source.path);
        let lines = fileCache.get(filePath);
        if (!lines) {
          lines = fs.readFileSync(filePath, 'utf8').split('\n');
          fileCache.set(filePath, lines);
        }
        const targetText = figure.source.match ?? figure.value;

        let startIndex: number;
        let endIndex: number;
        let where: string;
        if (figure.source.anchor !== undefined) {
          // The section that starts at the anchor's heading line and runs to the next heading.
          const anchor = figure.source.anchor;
          const headingIndex = lines.findIndex((l) => l.includes(anchor));
          if (headingIndex === -1) {
            expect.fail(`Entry ${entry.id}, label "${figure.label}": anchor "${anchor}" not found in ${figure.source.path}`);
          }
          const nextHeading = lines.findIndex((l, i) => i > headingIndex && /^#{2,3} /.test(l));
          startIndex = headingIndex;
          endIndex = nextHeading === -1 ? lines.length : nextHeading;
          where = `the section headed "${anchor}"`;
        } else {
          const line = figure.source.line;
          // lines line - 2 to line + 2 (1-based inclusive)
          startIndex = Math.max(0, line - 3);
          endIndex = Math.min(lines.length, line + 2);
          where = `lines ${line - 2} to ${line + 2}`;
        }
        const slice = lines.slice(startIndex, endIndex);
        const found = slice.some((l) => l.includes(targetText));

        if (!found) {
          const linesRead = slice
            .map((l, idx) => `  line ${startIndex + idx + 1}: ${l}`)
            .join('\n');
          expect.fail(
            `Entry ${entry.id}, label "${figure.label}": expected "${targetText}" within ${where} of ${figure.source.path}.\nLines read:\n${linesRead}`
          );
        }
      }
    }
  });

  it('cites the changelog by section anchor, never by line, because it grows at the top', () => {
    for (const entry of RESEARCH_CATALOG) {
      for (const figure of entry.figures) {
        if (figure.source.path === 'changelogs/CHANGELOG.md') {
          expect(figure.source.anchor, `Entry ${entry.id}, label "${figure.label}" cites the changelog by line`).toBeTruthy();
        }
      }
      if (entry.runs) {
        for (const run of entry.runs) {
          if (run.source.path === 'changelogs/CHANGELOG.md') {
            expect(run.source.anchor, `Entry ${entry.id}, run "${run.label}" cites the changelog by line`).toBeTruthy();
          }
        }
      }
      if (entry.trials && entry.trials.source.path === 'changelogs/CHANGELOG.md') {
        expect(entry.trials.source.anchor, `Entry ${entry.id}, trials cites the changelog by line`).toBeTruthy();
      }
    }
  });

  it('every run date is a real YYYY-MM-DD date', () => {
    for (const entry of RESEARCH_CATALOG) {
      if (entry.runs) {
        for (const run of entry.runs) {
          expect(run.date, `Entry ${entry.id}, run "${run.label}" date must match YYYY-MM-DD`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
          const [year, month, day] = run.date.split('-').map(Number);
          expect(month, `Entry ${entry.id}, run "${run.label}" has invalid month`).toBeGreaterThanOrEqual(1);
          expect(month, `Entry ${entry.id}, run "${run.label}" has invalid month`).toBeLessThanOrEqual(12);
          expect(day, `Entry ${entry.id}, run "${run.label}" has invalid day`).toBeGreaterThanOrEqual(1);
          expect(day, `Entry ${entry.id}, run "${run.label}" has invalid day`).toBeLessThanOrEqual(31);
          const dateObj = new Date(Date.UTC(year, month - 1, day));
          expect(dateObj.getUTCFullYear()).toBe(year);
          expect(dateObj.getUTCMonth() + 1).toBe(month);
          expect(dateObj.getUTCDate()).toBe(day);
        }
      }
    }
  });

  it('proves every run source date/match appears at its cited line (plus or minus 2) or in its anchored section, and commit/dataset/image appear in the source file', () => {
    const cwd = process.cwd();
    const fileCache = new Map<string, string[]>();

    for (const entry of RESEARCH_CATALOG) {
      if (entry.runs) {
        for (const run of entry.runs) {
          const filePath = path.join(cwd, run.source.path);
          let lines = fileCache.get(filePath);
          if (!lines) {
            lines = fs.readFileSync(filePath, 'utf8').split('\n');
            fileCache.set(filePath, lines);
          }
          const targetText = run.source.match ?? run.date;

          let startIndex: number;
          let endIndex: number;
          let where: string;
          if (run.source.anchor !== undefined) {
            const anchor = run.source.anchor;
            const headingIndex = lines.findIndex((l) => l.includes(anchor));
            if (headingIndex === -1) {
              expect.fail(`Entry ${entry.id}, run "${run.label}": anchor "${anchor}" not found in ${run.source.path}`);
            }
            const nextHeading = lines.findIndex((l, i) => i > headingIndex && /^#{2,3} /.test(l));
            startIndex = headingIndex;
            endIndex = nextHeading === -1 ? lines.length : nextHeading;
            where = `the section headed "${anchor}"`;
          } else {
            const line = run.source.line;
            startIndex = Math.max(0, line - 3);
            endIndex = Math.min(lines.length, line + 2);
            where = `lines ${line - 2} to ${line + 2}`;
          }
          const slice = lines.slice(startIndex, endIndex);
          const found = slice.some((l) => l.includes(targetText));

          if (!found) {
            const linesRead = slice
              .map((l, idx) => `  line ${startIndex + idx + 1}: ${l}`)
              .join('\n');
            expect.fail(
              `Entry ${entry.id}, run "${run.label}": expected "${targetText}" within ${where} of ${run.source.path}.\nLines read:\n${linesRead}`
            );
          }

          const fileContent = lines.join('\n');
          if (run.commit) {
            expect(
              fileContent.includes(run.commit),
              `Entry ${entry.id}, run "${run.label}": commit "${run.commit}" not found in ${run.source.path}`
            ).toBe(true);
          }
          if (run.dataset) {
            expect(
              fileContent.includes(run.dataset),
              `Entry ${entry.id}, run "${run.label}": dataset "${run.dataset}" not found in ${run.source.path}`
            ).toBe(true);
          }
          if (run.image) {
            expect(
              fileContent.includes(run.image),
              `Entry ${entry.id}, run "${run.label}": image "${run.image}" not found in ${run.source.path}`
            ).toBe(true);
          }
        }
      }
    }
  });

  it('proves every trials source count/match appears at its cited line (plus or minus 2) or in its anchored section', () => {
    const cwd = process.cwd();
    const fileCache = new Map<string, string[]>();

    for (const entry of RESEARCH_CATALOG) {
      if (entry.trials) {
        const trials = entry.trials;
        const filePath = path.join(cwd, trials.source.path);
        let lines = fileCache.get(filePath);
        if (!lines) {
          lines = fs.readFileSync(filePath, 'utf8').split('\n');
          fileCache.set(filePath, lines);
        }
        const targetText = trials.source.match ?? String(trials.count);

        let startIndex: number;
        let endIndex: number;
        let where: string;
        if (trials.source.anchor !== undefined) {
          const anchor = trials.source.anchor;
          const headingIndex = lines.findIndex((l) => l.includes(anchor));
          if (headingIndex === -1) {
            expect.fail(`Entry ${entry.id}, trials: anchor "${anchor}" not found in ${trials.source.path}`);
          }
          const nextHeading = lines.findIndex((l, i) => i > headingIndex && /^#{2,3} /.test(l));
          startIndex = headingIndex;
          endIndex = nextHeading === -1 ? lines.length : nextHeading;
          where = `the section headed "${anchor}"`;
        } else {
          const line = trials.source.line;
          startIndex = Math.max(0, line - 3);
          endIndex = Math.min(lines.length, line + 2);
          where = `lines ${line - 2} to ${line + 2}`;
        }
        const slice = lines.slice(startIndex, endIndex);
        const found = slice.some((l) => l.includes(targetText));

        if (!found) {
          const linesRead = slice
            .map((l, idx) => `  line ${startIndex + idx + 1}: ${l}`)
            .join('\n');
          expect.fail(
            `Entry ${entry.id}, trials: expected "${targetText}" within ${where} of ${trials.source.path}.\nLines read:\n${linesRead}`
          );
        }
      }
    }
  });

  it('LEDGER_TOTAL equals ledgerTotal() from scripts/research/ledger.ts', () => {
    expect(LEDGER_TOTAL).toBe(ledgerTotal());
  });

  it('no entry has status validated', () => {
    // A real validation updates this test together with its lock's RESULT block.
    for (const entry of RESEARCH_CATALOG) {
      expect(
        entry.status,
        `Entry ${entry.id} has status validated, which is forbidden until verified forward crossing`
      ).not.toBe('validated');
    }
  });

  it('every id in labHypotheses exists in LAB_HYPOTHESES_V1 to LAB_HYPOTHESES_V4, and every hypothesis id appears in exactly one entry', () => {
    const allLabHypotheses = [
      ...LAB_HYPOTHESES_V1,
      ...LAB_HYPOTHESES_V2,
      ...LAB_HYPOTHESES_V3,
      ...LAB_HYPOTHESES_V4,
    ];
    const expectedIds = new Set(allLabHypotheses.map((h) => h.id));
    const seenIds = new Map<string, string>();

    for (const entry of RESEARCH_CATALOG) {
      if (entry.labHypotheses) {
        for (const hypId of entry.labHypotheses) {
          expect(
            expectedIds.has(hypId),
            `Hypothesis ${hypId} in entry ${entry.id} not found in LAB_HYPOTHESES_V1..V4`
          ).toBe(true);

          if (seenIds.has(hypId)) {
            expect.fail(
              `Hypothesis ${hypId} appears in multiple entries: ${seenIds.get(hypId)} and ${entry.id}`
            );
          }
          seenIds.set(hypId, entry.id);
        }
      }
    }

    for (const expectedId of expectedIds) {
      expect(
        seenIds.has(expectedId),
        `Hypothesis ${expectedId} from LAB_HYPOTHESES_V1..V4 does not appear in any catalog entry`
      ).toBe(true);
    }
  });

  it('every symbol in symbols ends in USDT', () => {
    for (const entry of RESEARCH_CATALOG) {
      if (entry.symbols) {
        for (const symbol of entry.symbols) {
          expect(
            symbol.endsWith('USDT'),
            `Symbol ${symbol} in entry ${entry.id} does not end in USDT`
          ).toBe(true);
        }
      }
    }
  });

  it('orders families in the exact required sequence and preserves family grouping', () => {
    const expectedFamilyOrder: ResearchFamily[] = [
      'forward-lab',
      'next-version',
      'relative-value',
      'price-score',
      'research-program',
    ];

    expect(Object.keys(RESEARCH_FAMILIES)).toEqual(expectedFamilyOrder);

    let currentFamilyIndex = 0;
    for (const entry of RESEARCH_CATALOG) {
      const familyIndex = expectedFamilyOrder.indexOf(entry.family);
      expect(
        familyIndex,
        `Family ${entry.family} found out of order in catalog`
      ).toBeGreaterThanOrEqual(currentFamilyIndex);
      currentFamilyIndex = familyIndex;
    }
  });

  it('every entry has at least one run', () => {
    for (const entry of RESEARCH_CATALOG) {
      expect(entry.runs?.length ?? 0, `Entry ${entry.id} must have at least one run`).toBeGreaterThanOrEqual(1);
    }
  });
});
