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

  it('proves every figure text appears within lines line - 2 to line + 2 in its source', () => {
    const cwd = process.cwd();
    const fileCache = new Map<string, string[]>();

    for (const entry of RESEARCH_CATALOG) {
      for (const figure of entry.figures) {
        const filePath = path.join(cwd, figure.source.path);
        if (!fileCache.has(filePath)) {
          const content = fs.readFileSync(filePath, 'utf8');
          fileCache.set(filePath, content.split('\n'));
        }

        const lines = fileCache.get(filePath)!;
        const line = figure.source.line;
        // lines line - 2 to line + 2 (1-based inclusive)
        const startIndex = Math.max(0, line - 3);
        const endIndex = Math.min(lines.length, line + 2);
        const slice = lines.slice(startIndex, endIndex);

        const targetText = figure.source.match ?? figure.value;
        const found = slice.some((l) => l.includes(targetText));

        if (!found) {
          const linesRead = slice
            .map((l, idx) => `  line ${startIndex + idx + 1}: ${l}`)
            .join('\n');
          expect.fail(
            `Entry ${entry.id}, label "${figure.label}": expected "${targetText}" within lines ${line - 2} to ${line + 2} of ${figure.source.path}.\nLines read:\n${linesRead}`
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
});
