import { describe, expect, it } from 'vitest';
import {
  solveRidge2x2,
  pearsonCorrelation,
  spearmanRankCorrelation,
  estimateDualBeta,
  summarizeIc,
  evaluatePairwiseLeadLag,
} from './cross-returns-leadlag';

describe('solveRidge2x2', () => {
  it('solves simple 2x2 system analytically', () => {
    // Identity system: [1 0; 0 1] * [x0; x1] = [3; 4]
    const [x0, x1] = solveRidge2x2(1, 0, 1, 3, 4, 0);
    expect(x0).toBeCloseTo(3, 4);
    expect(x1).toBeCloseTo(4, 4);
  });

  it('handles small determinant with ridge penalty', () => {
    // Collinear system without ridge would divide by zero
    const [x0, x1] = solveRidge2x2(1, 1, 1, 2, 2, 0.01);
    expect(Number.isFinite(x0)).toBe(true);
    expect(Number.isFinite(x1)).toBe(true);
    expect(x0).toBeCloseTo(x1, 2);
  });
});

describe('pearsonCorrelation and spearmanRankCorrelation', () => {
  it('computes exact Pearson correlation', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(1.0, 5);

    const yNeg = [-1, -2, -3, -4, -5];
    expect(pearsonCorrelation(x, yNeg)).toBeCloseTo(-1.0, 5);

    const yFlat = [1, 1, 1, 1, 1];
    expect(pearsonCorrelation(x, yFlat)).toBe(0);
  });

  it('computes exact Spearman Rank correlation on non-linear monotonic data', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [1, 8, 27, 64, 125]; // y = x^3 (monotonic, but non-linear)

    expect(spearmanRankCorrelation(x, y)).toBeCloseTo(1.0, 5);
    expect(pearsonCorrelation(x, y)).toBeLessThan(1.0);
  });
});

describe('estimateDualBeta', () => {
  it('estimates bivariate beta coefficients accurately', () => {
    // Generate synthetic series where Asset = 1.2 * BTC - 0.5 * BNB + noise
    const n = 50;
    const btc: number[] = [];
    const bnb: number[] = [];
    const asset: number[] = [];

    for (let i = 0; i < n; i++) {
      const b = Math.sin(i * 0.3) * 0.05;
      const sec = Math.cos(i * 0.4) * 0.04;
      btc.push(b);
      bnb.push(sec);
      asset.push(1.2 * b - 0.5 * sec);
    }

    const res = estimateDualBeta(asset, btc, bnb, 1e-6);
    expect(res.betaBtc).toBeCloseTo(1.2, 2);
    expect(res.betaSecond).toBeCloseTo(-0.5, 2);
    expect(res.rSquared).toBeGreaterThan(0.95);
  });
});

describe('summarizeIc', () => {
  it('correctly calculates Mean IC, IR, and t-statistic', () => {
    const ics = [0.05, 0.03, 0.04, 0.06, 0.02];
    const summary = summarizeIc('TestFactor', ics);

    expect(summary.meanIc).toBeCloseTo(0.04, 4);
    expect(summary.numBars).toBe(5);
    expect(summary.positivePct).toBe(100);
    expect(summary.tStat).toBeGreaterThan(0);
  });
});

describe('evaluatePairwiseLeadLag', () => {
  it('detects lead-lag relationship in synthetic ARDL series', () => {
    const n = 100;
    const target: number[] = [0];
    const lead: number[] = [0];

    // Synthetic lead-lag: target at t+1 is negatively correlated with lead at t
    for (let i = 0; i < n; i++) {
      const l = (Math.sin(i * 0.5) + Math.cos(i * 0.2)) * 0.02;
      lead.push(l);
      const t = -0.6 * l + 0.1 * target[target.length - 1];
      target.push(t);
    }

    const fit = evaluatePairwiseLeadLag(target, lead);
    expect(fit.crossLagBeta).toBeLessThan(0);
    expect(Math.abs(fit.tStatCrossLag)).toBeGreaterThan(2.0);
  });
});
