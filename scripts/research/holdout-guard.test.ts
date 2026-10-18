// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';

function findTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('holdout guard', () => {
  it('asserts only approved files call readJsonlGz or parseJsonlGz', () => {
    const researchDir = __dirname;
    const tsFiles = findTsFiles(researchDir);
    const callPattern = /\b(?:readJsonlGz|parseJsonlGz)\s*(?:<[^()]*>)?\s*\(/;

    const callers: string[] = [];
    for (const file of tsFiles) {
      const content = readFileSync(file, 'utf8');
      if (callPattern.test(content)) {
        callers.push(relative(researchDir, file));
      }
    }

    callers.sort();
    expect(callers).toEqual([
      'dataset-format.ts',
      'lab-preview.ts',
      'load-dataset.ts',
      // Reads the v8 re-score rows (a study output, 2025-10 onward, no segment A) for the parity report.
      'nv1-c1.ts',
      'rv-panel.ts',
    ]);
  });
});
