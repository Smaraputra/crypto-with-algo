import { describe, expect, it } from 'vitest';

import { V8_STATUS } from './v8-status';

describe('V8_STATUS', () => {
  it('carries the label, the as-of date and the four studies', () => {
    expect(V8_STATUS.label).toBe('Measured: no edge');
    expect(V8_STATUS.asOf).toBe('2026-10-14');
    expect(V8_STATUS.studies.map((s) => s.date)).toEqual([
      '2026-10-10',
      '2026-10-10',
      '2026-10-10',
      '2026-10-11',
    ]);
  });

  it('is written without dashes or semicolons', () => {
    const text = [V8_STATUS.summary, ...V8_STATUS.studies.flatMap((s) => [s.name, s.verdict])].join(' ');
    expect(text).not.toMatch(/[\u2013\u2014;]/);
  });
});
