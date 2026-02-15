import { describe, it, expect } from 'vitest';
import {
  SignalTemplate,
  DEFAULT_TEMPLATE_WEIGHTS,
  DEFAULT_TEMPLATE_THRESHOLDS,
} from './signal-template';

function makeValidWeights() {
  return {
    trend: 0.25,
    momentum: 0.30,
    volume: 0.20,
    volatility: 0.10,
    futures: 0.10,
    sentiment: 0.05,
  };
}

function makeValidThresholds() {
  return {
    entryThreshold: 40,
    exitThreshold: 10,
    shortEntryThreshold: -40,
    shortExitThreshold: -10,
  };
}

function makeValidData(overrides = {}) {
  return {
    tradingStyle: 'day_trading',
    version: 1,
    weights: makeValidWeights(),
    thresholds: makeValidThresholds(),
    ...overrides,
  };
}

describe('SignalTemplate model', () => {
  it('validates a document with all required fields', () => {
    const doc = new SignalTemplate(makeValidData());
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('sets default values for optional fields', () => {
    const doc = new SignalTemplate(makeValidData());
    expect(doc.active).toBe(false);
    expect(doc.performanceMetrics.avgSharpe).toBe(0);
    expect(doc.performanceMetrics.avgWinRate).toBe(0);
    expect(doc.performanceMetrics.totalBacktests).toBe(0);
    expect(doc.performanceMetrics.lastOptimizedAt).toBeNull();
  });

  it('defaults version to 1', () => {
    const doc = new SignalTemplate(
      makeValidData({ version: undefined })
    );
    expect(doc.version).toBe(1);
  });

  it('accepts all valid trading styles', () => {
    const styles = ['scalping', 'day_trading', 'swing_trading', 'position_trading'];
    for (const style of styles) {
      const doc = new SignalTemplate(makeValidData({ tradingStyle: style }));
      const err = doc.validateSync();
      expect(err).toBeUndefined();
      expect(doc.tradingStyle).toBe(style);
    }
  });

  it('rejects invalid trading style', () => {
    const doc = new SignalTemplate(makeValidData({ tradingStyle: 'invalid_style' }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('tradingStyle');
  });

  it('stores weights correctly', () => {
    const weights = makeValidWeights();
    const doc = new SignalTemplate(makeValidData({ weights }));
    expect(doc.weights.trend).toBe(0.25);
    expect(doc.weights.momentum).toBe(0.30);
    expect(doc.weights.volume).toBe(0.20);
    expect(doc.weights.volatility).toBe(0.10);
    expect(doc.weights.futures).toBe(0.10);
    expect(doc.weights.sentiment).toBe(0.05);
  });

  it('stores thresholds correctly', () => {
    const doc = new SignalTemplate(makeValidData());
    expect(doc.thresholds.entryThreshold).toBe(40);
    expect(doc.thresholds.exitThreshold).toBe(10);
    expect(doc.thresholds.shortEntryThreshold).toBe(-40);
    expect(doc.thresholds.shortExitThreshold).toBe(-10);
  });

  it('accepts custom performanceMetrics', () => {
    const doc = new SignalTemplate(
      makeValidData({
        performanceMetrics: {
          avgSharpe: 1.8,
          avgWinRate: 0.62,
          totalBacktests: 25,
          lastOptimizedAt: new Date('2024-06-01'),
        },
      })
    );
    expect(doc.performanceMetrics.avgSharpe).toBe(1.8);
    expect(doc.performanceMetrics.avgWinRate).toBe(0.62);
    expect(doc.performanceMetrics.totalBacktests).toBe(25);
    expect(doc.performanceMetrics.lastOptimizedAt).toEqual(new Date('2024-06-01'));
  });

  it('accepts active flag', () => {
    const doc = new SignalTemplate(makeValidData({ active: true }));
    expect(doc.active).toBe(true);
  });

  it('rejects missing tradingStyle', () => {
    const doc = new SignalTemplate(makeValidData({ tradingStyle: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('tradingStyle');
  });

  it('rejects missing weights', () => {
    const doc = new SignalTemplate(makeValidData({ weights: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('weights');
  });

  it('rejects missing thresholds', () => {
    const doc = new SignalTemplate(makeValidData({ thresholds: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('thresholds');
  });

  it('rejects missing weights.trend', () => {
    const weights = { ...makeValidWeights(), trend: undefined };
    const doc = new SignalTemplate(makeValidData({ weights }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('weights.trend');
  });

  it('rejects missing weights.momentum', () => {
    const weights = { ...makeValidWeights(), momentum: undefined };
    const doc = new SignalTemplate(makeValidData({ weights }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('weights.momentum');
  });

  it('rejects missing weights.volume', () => {
    const weights = { ...makeValidWeights(), volume: undefined };
    const doc = new SignalTemplate(makeValidData({ weights }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('weights.volume');
  });

  it('rejects missing weights.volatility', () => {
    const weights = { ...makeValidWeights(), volatility: undefined };
    const doc = new SignalTemplate(makeValidData({ weights }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('weights.volatility');
  });

  it('rejects missing weights.futures', () => {
    const weights = { ...makeValidWeights(), futures: undefined };
    const doc = new SignalTemplate(makeValidData({ weights }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('weights.futures');
  });

  it('rejects missing weights.sentiment', () => {
    const weights = { ...makeValidWeights(), sentiment: undefined };
    const doc = new SignalTemplate(makeValidData({ weights }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('weights.sentiment');
  });

  it('rejects missing thresholds.entryThreshold', () => {
    const thresholds = { ...makeValidThresholds(), entryThreshold: undefined };
    const doc = new SignalTemplate(makeValidData({ thresholds }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('thresholds.entryThreshold');
  });

  it('rejects missing thresholds.exitThreshold', () => {
    const thresholds = { ...makeValidThresholds(), exitThreshold: undefined };
    const doc = new SignalTemplate(makeValidData({ thresholds }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('thresholds.exitThreshold');
  });

  it('rejects missing thresholds.shortEntryThreshold', () => {
    const thresholds = { ...makeValidThresholds(), shortEntryThreshold: undefined };
    const doc = new SignalTemplate(makeValidData({ thresholds }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('thresholds.shortEntryThreshold');
  });

  it('rejects missing thresholds.shortExitThreshold', () => {
    const thresholds = { ...makeValidThresholds(), shortExitThreshold: undefined };
    const doc = new SignalTemplate(makeValidData({ thresholds }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('thresholds.shortExitThreshold');
  });

  it('generates an _id automatically', () => {
    const doc = new SignalTemplate(makeValidData());
    expect(doc._id).toBeDefined();
  });
});

describe('DEFAULT_TEMPLATE_WEIGHTS', () => {
  it('has entries for all four trading styles', () => {
    expect(DEFAULT_TEMPLATE_WEIGHTS).toHaveProperty('scalping');
    expect(DEFAULT_TEMPLATE_WEIGHTS).toHaveProperty('day_trading');
    expect(DEFAULT_TEMPLATE_WEIGHTS).toHaveProperty('swing_trading');
    expect(DEFAULT_TEMPLATE_WEIGHTS).toHaveProperty('position_trading');
  });

  it('weights sum to approximately 1.0 for each style', () => {
    for (const style of Object.keys(DEFAULT_TEMPLATE_WEIGHTS) as Array<
      keyof typeof DEFAULT_TEMPLATE_WEIGHTS
    >) {
      const w = DEFAULT_TEMPLATE_WEIGHTS[style];
      const sum = w.trend + w.momentum + w.volume + w.volatility + w.futures + w.sentiment;
      expect(sum).toBeCloseTo(1.0);
    }
  });

  it('scalping emphasizes momentum', () => {
    const w = DEFAULT_TEMPLATE_WEIGHTS.scalping;
    expect(w.momentum).toBeGreaterThan(w.trend);
    expect(w.momentum).toBeGreaterThan(w.volume);
  });

  it('position_trading emphasizes trend', () => {
    const w = DEFAULT_TEMPLATE_WEIGHTS.position_trading;
    expect(w.trend).toBeGreaterThan(w.momentum);
    expect(w.trend).toBeGreaterThan(w.volume);
  });
});

describe('DEFAULT_TEMPLATE_THRESHOLDS', () => {
  it('has entries for all four trading styles', () => {
    expect(DEFAULT_TEMPLATE_THRESHOLDS).toHaveProperty('scalping');
    expect(DEFAULT_TEMPLATE_THRESHOLDS).toHaveProperty('day_trading');
    expect(DEFAULT_TEMPLATE_THRESHOLDS).toHaveProperty('swing_trading');
    expect(DEFAULT_TEMPLATE_THRESHOLDS).toHaveProperty('position_trading');
  });

  it('scalping has highest entry threshold', () => {
    expect(DEFAULT_TEMPLATE_THRESHOLDS.scalping.entryThreshold).toBe(50);
    expect(DEFAULT_TEMPLATE_THRESHOLDS.scalping.entryThreshold).toBeGreaterThan(
      DEFAULT_TEMPLATE_THRESHOLDS.day_trading.entryThreshold
    );
  });

  it('position_trading has lowest entry threshold', () => {
    expect(DEFAULT_TEMPLATE_THRESHOLDS.position_trading.entryThreshold).toBe(30);
    expect(DEFAULT_TEMPLATE_THRESHOLDS.position_trading.entryThreshold).toBeLessThan(
      DEFAULT_TEMPLATE_THRESHOLDS.swing_trading.entryThreshold
    );
  });

  it('short entry thresholds are negative of entry thresholds', () => {
    for (const style of Object.keys(DEFAULT_TEMPLATE_THRESHOLDS) as Array<
      keyof typeof DEFAULT_TEMPLATE_THRESHOLDS
    >) {
      const t = DEFAULT_TEMPLATE_THRESHOLDS[style];
      expect(t.shortEntryThreshold).toBe(-t.entryThreshold);
    }
  });
});
