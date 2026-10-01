// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formatSpacing, parseArgs } from './funding-spacing';

describe('funding-spacing parseArgs', () => {
  it('defaults to the research dataset and every signal symbol', () => {
    const args = parseArgs([]);
    expect(args.datasetDir).toBe('data/research');
    expect(args.symbols).toHaveLength(10);
    expect(args.json).toBe(false);
  });
  it('parses the dataset dir, a symbol list and --json', () => {
    const args = parseArgs(['--dataset-dir', '/ds', '--symbols', 'BTCUSDT,ETHUSDT', '--json']);
    expect(args).toEqual({ datasetDir: '/ds', symbols: ['BTCUSDT', 'ETHUSDT'], json: true });
  });
  it('rejects an unknown flag and a missing value', () => {
    expect(() => parseArgs(['--bogus', 'x'])).toThrow(/Unknown flag --bogus/);
    expect(() => parseArgs(['--dataset-dir'])).toThrow(/Missing value/);
  });
});

describe('formatSpacing', () => {
  it('prints one line per symbol-year with the interval mix and the rate range in percent', () => {
    const text = formatSpacing({
      BTCUSDT: [
        {
          year: 2024,
          settlements: 1098,
          spacingMismatches: 0,
          missingSpan: 0,
          intervalSwitches: 0,
          byInterval: { '8': 1098 },
          minRate: -0.0002,
          maxRate: 0.0011,
          baseRateShare: 0.412,
          atExtreme: 1,
        },
      ],
    });
    expect(text).toContain('BTCUSDT');
    expect(text).toContain('8h:1098');
    expect(text).toContain('0.1100');
    expect(text).toContain('0.412');
  });
});
