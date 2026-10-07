import { describe, expect, it } from 'vitest';
import { PRIMARY_FROM, rulePaths, runTrendStudy } from './trend-harness';
import { syntheticInputs } from './trend-fixtures';
import { DAY_MS } from './trend-signals';
import { TREND_COST, runTrend, type SimOptions } from './trend-sim';

/**
 * Characterisation (golden) tests: they pin the trend container's current
 * outputs byte for byte. A later change that alters default behaviour must
 * fail here. Regenerate a golden only on purpose (`vitest run -u`).
 */

/** Wall-clock or environment fields of a TrendReport, removed before pinning. */
const VOLATILE_FIELDS = ['computedAt', 'gitCommit', 'durationMs'];

/** JSON with object keys sorted recursively; numbers go through JSON so doubles round-trip exactly. */
function stableStringify(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sort((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 1) + '\n';
}

const inputs = syntheticInputs();
const symbols = inputs.primary.map((i) => i.symbol);

describe('golden: runTrendStudy', () => {
  it.each(['TF1', 'TF2', 'TF3', 'TF4', 'C3'] as const)('%s report is pinned', async (rule) => {
    const report = runTrendStudy(
      { rule, datasetDir: '/unused', symbols, out: '/unused', taskId: 't', draws: 3 },
      inputs,
      'hash'
    ) as unknown as Record<string, unknown>;
    for (const f of VOLATILE_FIELDS) delete report[f];
    await expect(stableStringify(report)).toMatchFileSnapshot(`./__golden__/trend-${rule.toLowerCase()}.json`);
  });
});

describe('golden: runTrend', () => {
  const to = Date.UTC(2021, 0, 1);
  const opts: SimOptions = { from: PRIMARY_FROM, to, cost: TREND_COST, delay: 1 };
  const run = runTrend(inputs.primary, rulePaths('TF4', inputs.primary), opts);

  it('covers a mid-sample join, month ends and delay 1', () => {
    expect(opts.delay).toBe(1);
    // BBB and CCC list after the sample start: they join mid-sample.
    const joined = Object.entries(run.startDay).filter(([, d]) => d > run.days[0]);
    expect(joined.map(([s]) => s).sort()).toEqual(['BBBUSDT', 'CCCUSDT']);
    expect(run.days[0]).toBe(PRIMARY_FROM);
    // Month ends strictly inside the sample, after at least one sleeve is live.
    const monthEnds = run.days.filter(
      (d) => new Date(d + DAY_MS).getUTCDate() === 1 && d > PRIMARY_FROM && d < to - DAY_MS
    );
    expect(monthEnds.length).toBeGreaterThanOrEqual(2);
    expect(run.days.length).toBe((to - PRIMARY_FROM) / DAY_MS);
  });

  it('the full TrendRun is pinned', async () => {
    await expect(stableStringify(run)).toMatchFileSnapshot('./__golden__/trend-run.json');
  });
});
