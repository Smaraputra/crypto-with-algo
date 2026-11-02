import { writeFileSync } from 'node:fs';
import { expectedMaxSharpe, probabilisticSharpe, deflatedSharpe, perPeriodSharpe, psrRadicand } from '../../../../../src/lib/stats/deflated-sharpe';
import { normalCdf, normalQuantile, sampleSkewness, sampleKurtosis } from '../../../../../src/lib/stats/normal';
import { createSeededRandom } from '../../../../../src/lib/stats/seeded-random';

const rand = createSeededRandom(20261025);
const series = (n: number, drift: number) => Array.from({ length: n }, () => drift + (rand() - 0.5) * 0.04 + (rand() < 0.02 ? (rand() - 0.5) * 0.3 : 0));
const samples = [series(50, 0), series(300, 0.001), series(1000, -0.0005), [0.01, -0.02, 0.03, 0.0, 0.015, -0.005]];

const emax = [];
for (const numTrials of [1, 2, 11, 54, 120, 342, 2204, 2324]) for (const v of [0, 1e-4, 0.0025, 0.01]) emax.push({ numTrials, varianceOfTrialSharpes: v, expectedMaxSharpe: expectedMaxSharpe(numTrials, v) });

const psr = [];
for (const sr of [-0.05, 0, 0.03, 0.1, 0.3]) for (const bench of [0, 0.02, 0.08]) for (const n of [50, 500, 5000]) for (const [skew, kurt] of [[0, 3], [-0.5, 6], [0.8, 10], [6, 10]])
  psr.push({ observedSharpe: sr, benchmarkSharpe: bench, nObservations: n, skewness: skew, kurtosis: kurt, radicand: psrRadicand(sr, skew, kurt), probability: probabilisticSharpe(sr, bench, n, skew, kurt) });

const dsr = [];
for (const s of samples) {
  const sr = perPeriodSharpe(s);
  const skew = sampleSkewness(s);
  const kurt = sampleKurtosis(s);
  for (const numTrials of [11, 120, 2324]) for (const v of [1e-4, 0.0025]) {
    const out = deflatedSharpe({ observedSharpe: sr, numTrials, varianceOfTrialSharpes: v, nObservations: s.length, skewness: skew, kurtosis: kurt });
    dsr.push({ n: s.length, numTrials, varianceOfTrialSharpes: v, observedSharpe: sr, skewness: skew, kurtosis: kurt, ...out });
  }
}

const normal = [];
for (const x of [-8, -3, -1.96, -1, -0.1, 0, 0.5, 1.645, 2.5, 6]) normal.push({ x, cdf: normalCdf(x) });
const quant = [];
for (const p of [1e-6, 0.001, 0.025, 0.1, 0.5, 0.9, 0.975, 0.999, 1 - 1 / 2324, 1 - 1 / (2324 * Math.E)]) quant.push({ p, q: normalQuantile(p) });

writeFileSync(process.argv[2], JSON.stringify({
  source: 'src/lib/stats/deflated-sharpe.ts, src/lib/stats/normal.ts (accuracy target 1e-7)',
  samples, emax, psr, dsr, normal, quant,
  moments: samples.map((s) => ({ n: s.length, perPeriodSharpe: perPeriodSharpe(s), skewness: sampleSkewness(s), kurtosis: sampleKurtosis(s) })),
}, null, 1) + '\n');
console.log('emax', emax.length, 'psr', psr.length, 'dsr', dsr.length);
process.exit(0);
