import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('marketing-v2 imports', () => {
  it('does not import animation libraries (three, gsap, lenis, framer-motion)', () => {
    const dir = path.resolve(__dirname);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'));

    expect(files.length).toBeGreaterThan(0);

    const bannedImportPattern = /from\s+['"](three|@react-three|gsap|@gsap|lenis|framer-motion)['"]|import\s+['"](three|@react-three|gsap|@gsap|lenis|framer-motion)['"]/;

    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), 'utf-8');
      expect(
        bannedImportPattern.test(content),
        `File ${file} must not import banned animation libraries`
      ).toBe(false);
    }
  });
});
