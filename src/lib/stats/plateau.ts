/**
 * Parameter plateau score: how robust a chosen parameter set is to small
 * perturbations, by comparing the best result's metric against nearby
 * results in the same optimization run. A score near 1 means neighbors
 * perform about as well as the best (a plateau); a low score means the
 * best is an isolated spike.
 *
 * `best` must be one of the entries in `results` (matched by exact equality
 * on every key of `best`, via paramsEqual) - that entry supplies bestMetric
 * and is excluded from its own neighbor search. If no entry in `results`
 * matches `best`, bestMetric falls back to 0, which forces `score` to NaN
 * (see the `bestMetric > 0` gate below) rather than reporting a misleading
 * ratio computed against a metric of 0.
 */

interface OptimizationResult {
  params: Record<string, number>;
  metric: number;
}

function paramsEqual(
  a: Record<string, number>,
  dims: string[],
  best: Record<string, number>
): boolean {
  return dims.every((dim) => a[dim] === best[dim]);
}

export function parameterPlateauScore(
  results: OptimizationResult[],
  best: Record<string, number>,
  neighborRadius: number
): { score: number; neighbors: number; bestMetric: number } {
  const dims = Object.keys(best);

  const ranges: Record<string, number> = {};
  for (const dim of dims) {
    // Only finite values establish the range, so one row missing this
    // dimension (params[dim] === undefined, feeding NaN into Math.max/min)
    // does not poison the distance calculation for every other row on it.
    const values = results.map((r) => r.params[dim]).filter((v) => Number.isFinite(v));
    ranges[dim] = values.length > 0 ? Math.max(...values) - Math.min(...values) : NaN;
  }

  const bestEntry = results.find((r) => paramsEqual(r.params, dims, best));
  const bestMetric = bestEntry ? bestEntry.metric : 0;

  const neighborMetrics: number[] = [];
  for (const result of results) {
    if (paramsEqual(result.params, dims, best)) continue;

    let maxNormalizedDistance = 0;
    let disqualified = false;
    for (const dim of dims) {
      const range = ranges[dim];
      const param = result.params[dim];
      const distance =
        param === undefined ? NaN : range === 0 ? 0 : Math.abs(param - best[dim]) / range;
      // A non-finite range, param, or distance (e.g. a row missing this
      // dimension) disqualifies the row rather than silently sorting as
      // "close" (0 or NaN would otherwise pass an <= radius check).
      if (!Number.isFinite(distance)) {
        disqualified = true;
        break;
      }
      if (distance > maxNormalizedDistance) maxNormalizedDistance = distance;
    }

    if (!disqualified && maxNormalizedDistance <= neighborRadius) {
      neighborMetrics.push(result.metric);
    }
  }

  const neighbors = neighborMetrics.length;
  const score =
    bestMetric > 0 && neighbors > 0
      ? neighborMetrics.reduce((s, m) => s + m, 0) / neighbors / bestMetric
      : NaN;

  return { score, neighbors, bestMetric };
}
