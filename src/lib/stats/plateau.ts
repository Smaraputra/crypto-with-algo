/**
 * Parameter plateau score: how robust a chosen parameter set is to small
 * perturbations, by comparing the best result's metric against nearby
 * results in the same optimization run. A score near 1 means neighbors
 * perform about as well as the best (a plateau); a low score means the
 * best is an isolated spike.
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
    const values = results.map((r) => r.params[dim]);
    ranges[dim] = Math.max(...values) - Math.min(...values);
  }

  const bestEntry = results.find((r) => paramsEqual(r.params, dims, best));
  const bestMetric = bestEntry ? bestEntry.metric : 0;

  const neighborMetrics: number[] = [];
  for (const result of results) {
    if (paramsEqual(result.params, dims, best)) continue;

    let maxNormalizedDistance = 0;
    for (const dim of dims) {
      const range = ranges[dim];
      const distance = range === 0 ? 0 : Math.abs(result.params[dim] - best[dim]) / range;
      if (distance > maxNormalizedDistance) maxNormalizedDistance = distance;
    }

    if (maxNormalizedDistance <= neighborRadius) {
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
