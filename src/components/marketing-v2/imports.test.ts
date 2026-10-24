import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function getAllSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllSourceFiles(fullPath));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(fullPath);
    }
  }

  return files;
}

describe('marketing-v2 imports', () => {
  const rootDir = path.resolve(__dirname);
  const allFiles = getAllSourceFiles(rootDir);
  const heroDir = path.resolve(rootDir, 'hero');

  it('scans all files in marketing-v2 and subfolders', () => {
    expect(allFiles.length).toBeGreaterThan(0);
    const hasHeroFiles = allFiles.some((f) => f.startsWith(heroDir));
    expect(hasHeroFiles).toBe(true);
  });

  it('bans gsap, @gsap, lenis, framer-motion, and @react-three/drei everywhere', () => {
    const bannedPattern =
      /(?:from\s+['"]|import\s+['"])(?:gsap|@gsap|lenis|framer-motion|@react-three\/drei)(?:['"]|\/)/;

    for (const filePath of allFiles) {
      const relPath = path.relative(rootDir, filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(
        bannedPattern.test(content),
        `File ${relPath} must not import banned libraries (gsap, lenis, framer-motion, @react-three/drei)`
      ).toBe(false);
    }
  });

  it('allows three and @react-three/fiber only in files under hero/', () => {
    const threePattern =
      /(?:from\s+['"]|import\s+['"])(?:three|@react-three)(?:['"]|\/)/;

    for (const filePath of allFiles) {
      const isHero = filePath.startsWith(heroDir);
      if (isHero) continue;

      const relPath = path.relative(rootDir, filePath);
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(
        threePattern.test(content),
        `File ${relPath} outside hero/ must not import three or @react-three`
      ).toBe(false);
    }
  });

  it('asserts that hero/GlobeScene.tsx is imported only through next/dynamic with no static import in any other file', () => {
    const staticImportPattern =
      /(?:^|\n)\s*import\s+(?:(?!\()\S.*?)from\s+['"][^'"]*GlobeScene['"]/m;

    for (const filePath of allFiles) {
      const fileName = path.basename(filePath);
      if (fileName === 'GlobeScene.tsx') continue;

      const relPath = path.relative(rootDir, filePath);
      const content = fs.readFileSync(filePath, 'utf-8');

      expect(
        staticImportPattern.test(content),
        `File ${relPath} must not statically import GlobeScene`
      ).toBe(false);
    }

    // Verify that HeroGlobe.tsx imports GlobeScene dynamically
    const heroGlobePath = path.join(heroDir, 'HeroGlobe.tsx');
    const heroGlobeContent = fs.readFileSync(heroGlobePath, 'utf-8');
    expect(heroGlobeContent).toMatch(
      /dynamic\s*\(\s*\(\)\s*=>\s*import\(['"].*GlobeScene['"]\)/
    );
  });
});
