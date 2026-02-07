import { describe, expect, it } from 'vitest';

describe('canary', () => {
  it('vitest runs successfully', () => {
    expect(1 + 1).toBe(2);
  });

  it('path aliases resolve', async () => {
    // Verifies that @/ alias works in the test environment
    const mod = await import('@/test/setup');
    expect(mod).toBeDefined();
  });
});
