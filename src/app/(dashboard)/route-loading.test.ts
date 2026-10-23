import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const NON_ADMIN_ROUTES = [
  'dashboard',
  'focus',
  'portfolio',
  'alerts',
  'analytics',
  'journal',
  'research',
  'signals',
  'backtest',
  'cost-check',
  'lab',
] as const;

describe('route loading guards', () => {
  it('every non-admin dashboard route has a loading fallback', () => {
    for (const route of NON_ADMIN_ROUTES) {
      expect(existsSync(join(__dirname, route, 'loading.tsx'))).toBe(true);
    }
  });

  // A loading boundary turns the admin redirect() into a late client-side redirect after streaming.
  it('admin routes have no loading boundary, so their access redirect stays an HTTP redirect', () => {
    expect(existsSync(join(__dirname, 'loading.tsx'))).toBe(false);
    expect(existsSync(join(__dirname, 'admin', 'loading.tsx'))).toBe(false);

    const adminEntries = readdirSync(join(__dirname, 'admin'), { withFileTypes: true });
    for (const entry of adminEntries) {
      if (entry.isDirectory()) {
        expect(existsSync(join(__dirname, 'admin', entry.name, 'loading.tsx'))).toBe(false);
      }
    }
  });
});
