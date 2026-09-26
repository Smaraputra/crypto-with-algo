// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SIGNAL_CATEGORY, auditComposite, formatCompositeAudit, pickAuditHorizon } from './composite-audit';

describe('pickAuditHorizon', () => {
  it('takes the nearest report horizon and breaks ties toward the longer one', () => {
    expect(pickAuditHorizon([1, 2, 4, 8, 16, 32], 24)).toBe(32);
    expect(pickAuditHorizon([1, 2, 4, 8, 16, 32], 12)).toBe(16);
    expect(pickAuditHorizon([1, 2, 4, 8, 16, 32], 30)).toBe(32);
    expect(pickAuditHorizon([1, 2, 4, 8, 16, 32], 20)).toBe(16);
    expect(pickAuditHorizon([1, 2, 4, 8, 16, 32, 48], 24)).toBe(32);
  });
});

function pooledRow(h: number, ic: number, icT: number) {
  return { horizon: h, n: 1000, ic, icT, nNonOverlapping: 1000, icNonOverlapping: ic, signHitRate: 0.5, bootstrapCi95: null, quantileSpread: { top: 0, bottom: 0 } };
}
function factor(name: string, ic: number, icT: number) {
  return { name, category: name.split('.')[0], perSymbol: [], pooled: { horizons: [pooledRow(16, ic, icT), pooledRow(32, ic * 1.5, icT)] }, rollingQuarterly: [] };
}

const REPORT = {
  interval: '1h',
  horizons: [16, 32],
  factors: [
    factor('composite', -0.020, -6.0),
    factor('cat.trend', -0.030, -9.0),
    factor('cat.volatility', 0.025, 8.0),
    factor('sig.EMA Cross', -0.028, -8.0),
    factor('sig.Bollinger', 0.025, 8.0),
  ],
  skippedFactors: [],
};

describe('auditComposite', () => {
  it('flags wrong-signed signals, weights categories and reports the additive sum and ceiling', () => {
    const audit = auditComposite(REPORT as never, { sdPercent: 4.56 });
    expect(audit.style).toBe('day_trading');
    expect(audit.horizon).toBe(32);
    const ema = audit.signals.find((s) => s.name === 'EMA Cross')!;
    expect(ema.category).toBe('trend');
    expect(ema.ic).toBeCloseTo(-0.042, 6);
    expect(ema.liveSignAgrees).toBe(false);
    const boll = audit.signals.find((s) => s.name === 'Bollinger')!;
    expect(boll.liveSignAgrees).toBe(true);
    // day_trading weights: trend 0.2125, volatility 0.085
    expect(audit.additiveSum).toBeCloseTo(0.2125 * -0.045 + 0.085 * 0.0375, 6);
    expect(audit.additiveCeiling).toBeCloseTo(0.2125 * 0.045 + 0.085 * 0.0375, 6);
    expect(audit.compositeIc).toBeCloseTo(-0.03, 6);
    expect(audit.categoriesMissing).toEqual(['momentum', 'volume', 'futures', 'sentiment', 'htf']);
  });
  it('prints the cost lines for the interval under every profile', () => {
    const text = formatCompositeAudit(auditComposite(REPORT as never, { sdPercent: 4.56 }));
    expect(text).toMatch(/standard taker .*0\.0175/);
    expect(text).toMatch(/promo-btc-eth-2026-07 taker .*0\.0145/);
    expect(text).toMatch(/ceiling/);
  });
  it('refuses a sig name it cannot map', () => {
    const bad = { ...REPORT, factors: [...REPORT.factors, factor('sig.Mystery', 0.01, 1)] };
    expect(() => auditComposite(bad as never, { sdPercent: 4.56 })).toThrow(/Unmapped signal/);
  });
  it('maps every live signal name exactly once', () => {
    expect(Object.keys(SIGNAL_CATEGORY).length).toBe(20);
    expect(new Set(Object.values(SIGNAL_CATEGORY))).toEqual(new Set(['trend', 'momentum', 'volume', 'volatility', 'futures', 'sentiment', 'htf']));
  });

  // sig.News in the real reports (4h, 1d, 2026-09-26) reports fewer horizons
  // than the rest of the report because its stored aggregate rarely clears
  // the minimum sample; the audit horizon (day_trading -> h32 here) is not
  // among them, so it must fall back rather than throw.
  it('falls back to the nearest horizon a sparse signal actually has, and marks it', () => {
    const sparseNews = { ...factor('sig.News', 0.05, 3.0), pooled: { horizons: [pooledRow(1, 0.05, 3.0)] } };
    const report = { ...REPORT, factors: [...REPORT.factors, sparseNews] };
    const audit = auditComposite(report as never, { sdPercent: 4.56 });
    const news = audit.signals.find((s) => s.name === 'News')!;
    expect(news.horizonUsed).toBe(1);
    expect(news.ic).toBeCloseTo(0.05, 6);
    const text = formatCompositeAudit(audit);
    expect(text).toMatch(/News.*h1, not h32/);
  });
});
