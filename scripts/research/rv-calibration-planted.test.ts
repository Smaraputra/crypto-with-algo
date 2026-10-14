// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { pValue } from './rv-mcpt';
import { runCalibrationJob } from './rv-stages';

/**
 * Fast calibration smoke (Task 7B brief): the planted edge is found by both permutation steps at a small scale.
 * The header acceptance (10 seeds, 3,000 bars, M = 199) runs on the VPS through the calibrate stage.
 */
describe('fast calibration: planted edge (header seeds base + 210,000 + k, k = 1..5)', () => {
  it('gives p <= 0.05 on both steps on at least 4 of 5 seeds (900 bars, training 300, test 100, M = 19)', { timeout: 180_000 }, () => {
    const scale = { bars: 900, geometry: { train: 300, test: 100 }, M: 19 };
    const ps = [1, 2, 3, 4, 5].map((k) => {
      const o = runCalibrationJob('planted', k, 'a'.repeat(40), scale);
      return { is: pValue(o.is.real, o.is.nulls.map((l) => l.best)), wf: pValue(o.wf.real, o.wf.nulls.map((l) => l.best)) };
    });
    expect(ps.filter((p) => p.is <= 0.05).length).toBeGreaterThanOrEqual(4);
    expect(ps.filter((p) => p.wf <= 0.05).length).toBeGreaterThanOrEqual(4);
  });
});
