// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { CALIBRATION_UNIVERSES, RV_SEEDS, pValue, insampleShard, runCells } from './rv-mcpt';
import { ksUniform } from './rv-judge';
import { syntheticPanel } from './rv-synthetic';

/**
 * Fast calibration smoke (Task 7B brief): on driftless iid universes the step 2 (in-sample permutation) p-values
 * are uniform. The header acceptance (100 seeds, 3,000 bars, M = 99) runs on the VPS through the calibrate stage.
 */
describe('fast calibration: driftless iid universes, step 2 (in-sample permutation)', () => {
  it('gives a KS p above 0.01 against uniform over 30 seeds (250 bars, M = 19)', { timeout: 180_000 }, () => {
    const ps = Array.from({ length: 30 }, (_, i) => {
      const seed = CALIBRATION_UNIVERSES.iid.seed(i + 1);
      const panel = syntheticPanel({ bars: 250, symbols: 10, mode: 'iid', strength: 0, seed });
      return pValue(Math.max(...runCells(panel).objectives), insampleShard(panel, 1, 19, (m) => RV_SEEDS.inner(seed, m)).map((l) => l.best));
    });
    expect(ksUniform(ps).p).toBeGreaterThan(0.01);
    // the dangerous direction: an anti-conservative null piles p-values at the bottom
    expect(ps.filter((p) => p <= 0.05).length).toBeLessThanOrEqual(5);
  });
});
