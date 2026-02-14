import { describe, it, expect } from 'vitest';

import {
  STYLE_CONFIGS,
  TRADING_STYLES,
  getStyleConfig,
  shouldSkipIndicator,
} from './style-configs';
import type { TradingStyle } from '@/lib/models/signal-template';

describe('style-configs', () => {
  describe('STYLE_CONFIGS', () => {
    it('defines configs for all four trading styles', () => {
      expect(Object.keys(STYLE_CONFIGS)).toHaveLength(4);
      expect(STYLE_CONFIGS).toHaveProperty('scalping');
      expect(STYLE_CONFIGS).toHaveProperty('day_trading');
      expect(STYLE_CONFIGS).toHaveProperty('swing_trading');
      expect(STYLE_CONFIGS).toHaveProperty('position_trading');
    });

    it.each(TRADING_STYLES)('%s has valid IndicatorConfig with positive periods', (style) => {
      const profile = STYLE_CONFIGS[style];
      const { config } = profile;

      expect(config.ema.fast).toBeGreaterThan(0);
      expect(config.ema.slow).toBeGreaterThan(config.ema.fast);
      expect(config.sma.medium).toBeGreaterThan(0);
      expect(config.sma.long).toBeGreaterThan(config.sma.medium);
      expect(config.rsi.period).toBeGreaterThan(0);
      expect(config.rsi.overbought).toBeGreaterThan(config.rsi.oversold);
      expect(config.macd.fast).toBeGreaterThan(0);
      expect(config.macd.slow).toBeGreaterThan(config.macd.fast);
      expect(config.macd.signal).toBeGreaterThan(0);
      expect(config.bollingerBands.period).toBeGreaterThan(0);
      expect(config.bollingerBands.stdDev).toBeGreaterThan(0);
      expect(config.atr.period).toBeGreaterThan(0);
      expect(config.stochasticRSI.rsiPeriod).toBeGreaterThan(0);
      expect(config.stochasticRSI.stochasticPeriod).toBeGreaterThan(0);
      expect(config.stochasticRSI.kPeriod).toBeGreaterThan(0);
      expect(config.stochasticRSI.dPeriod).toBeGreaterThan(0);
      expect(config.williamsR.period).toBeGreaterThan(0);
      expect(config.ichimoku.conversionPeriod).toBeGreaterThan(0);
      expect(config.ichimoku.basePeriod).toBeGreaterThan(0);
      expect(config.ichimoku.spanPeriod).toBeGreaterThan(0);
      expect(config.ichimoku.displacement).toBeGreaterThan(0);
      expect(config.mfi.period).toBeGreaterThan(0);
    });

    it.each(TRADING_STYLES)('%s has valid profile metadata', (style) => {
      const profile = STYLE_CONFIGS[style];

      expect(profile.preferredIntervals.length).toBeGreaterThan(0);
      expect(profile.updateFrequencyMs).toBeGreaterThan(0);
      expect(profile.minCandles).toBeGreaterThan(0);
      expect(profile.recommendedCandles).toBeGreaterThanOrEqual(profile.minCandles);
      expect(profile.signalTTLSeconds).toBeGreaterThan(0);
      expect(Array.isArray(profile.skipIndicators)).toBe(true);
    });
  });

  describe('scalping differentiation', () => {
    it('uses fastest indicator periods', () => {
      const { config } = STYLE_CONFIGS.scalping;
      expect(config.ema.fast).toBe(5);
      expect(config.ema.slow).toBe(13);
      expect(config.rsi.period).toBe(7);
      expect(config.macd.fast).toBe(5);
      expect(config.atr.period).toBe(7);
    });

    it('skips ichimoku', () => {
      expect(STYLE_CONFIGS.scalping.skipIndicators).toContain('ichimoku');
    });

    it('prefers 1m and 5m intervals', () => {
      expect(STYLE_CONFIGS.scalping.preferredIntervals).toEqual(['1m', '5m']);
    });

    it('updates every 1 minute', () => {
      expect(STYLE_CONFIGS.scalping.updateFrequencyMs).toBe(60_000);
    });

    it('needs fewer candles than other styles', () => {
      expect(STYLE_CONFIGS.scalping.minCandles).toBeLessThan(STYLE_CONFIGS.day_trading.minCandles);
    });

    it('has shortest signal TTL', () => {
      expect(STYLE_CONFIGS.scalping.signalTTLSeconds).toBe(86_400);
      expect(STYLE_CONFIGS.scalping.signalTTLSeconds).toBeLessThan(
        STYLE_CONFIGS.day_trading.signalTTLSeconds
      );
    });
  });

  describe('day_trading differentiation', () => {
    it('uses standard indicator periods', () => {
      const { config } = STYLE_CONFIGS.day_trading;
      expect(config.ema.fast).toBe(12);
      expect(config.ema.slow).toBe(26);
      expect(config.rsi.period).toBe(14);
      expect(config.macd.fast).toBe(12);
    });

    it('does not skip any indicators', () => {
      expect(STYLE_CONFIGS.day_trading.skipIndicators).toHaveLength(0);
    });

    it('prefers 15m and 1h intervals', () => {
      expect(STYLE_CONFIGS.day_trading.preferredIntervals).toEqual(['15m', '1h']);
    });

    it('updates every 5 minutes', () => {
      expect(STYLE_CONFIGS.day_trading.updateFrequencyMs).toBe(300_000);
    });
  });

  describe('swing_trading differentiation', () => {
    it('uses slower indicator periods than day trading', () => {
      const { config } = STYLE_CONFIGS.swing_trading;
      expect(config.ema.fast).toBe(21);
      expect(config.ema.slow).toBe(55);
      expect(config.rsi.period).toBe(21);
      expect(config.rsi.period).toBeGreaterThan(STYLE_CONFIGS.day_trading.config.rsi.period);
    });

    it('prefers 4h and 1d intervals', () => {
      expect(STYLE_CONFIGS.swing_trading.preferredIntervals).toEqual(['4h', '1d']);
    });

    it('updates every 15 minutes', () => {
      expect(STYLE_CONFIGS.swing_trading.updateFrequencyMs).toBe(900_000);
    });
  });

  describe('position_trading differentiation', () => {
    it('uses slowest indicator periods', () => {
      const { config } = STYLE_CONFIGS.position_trading;
      expect(config.ema.fast).toBe(50);
      expect(config.ema.slow).toBe(200);
      expect(config.rsi.period).toBe(28);
      expect(config.sma.long).toBe(400);
    });

    it('uses extended ichimoku parameters', () => {
      const { config } = STYLE_CONFIGS.position_trading;
      expect(config.ichimoku.conversionPeriod).toBe(26);
      expect(config.ichimoku.basePeriod).toBe(52);
      expect(config.ichimoku.spanPeriod).toBe(104);
    });

    it('prefers 1d interval only', () => {
      expect(STYLE_CONFIGS.position_trading.preferredIntervals).toEqual(['1d']);
    });

    it('updates every 1 hour', () => {
      expect(STYLE_CONFIGS.position_trading.updateFrequencyMs).toBe(3_600_000);
    });

    it('has longest signal TTL', () => {
      expect(STYLE_CONFIGS.position_trading.signalTTLSeconds).toBe(7_776_000);
    });

    it('needs the most candles', () => {
      expect(STYLE_CONFIGS.position_trading.minCandles).toBeGreaterThanOrEqual(
        STYLE_CONFIGS.swing_trading.minCandles
      );
    });
  });

  describe('speed ordering across styles', () => {
    it('update frequency increases from scalping to position', () => {
      expect(STYLE_CONFIGS.scalping.updateFrequencyMs).toBeLessThan(
        STYLE_CONFIGS.day_trading.updateFrequencyMs
      );
      expect(STYLE_CONFIGS.day_trading.updateFrequencyMs).toBeLessThan(
        STYLE_CONFIGS.swing_trading.updateFrequencyMs
      );
      expect(STYLE_CONFIGS.swing_trading.updateFrequencyMs).toBeLessThan(
        STYLE_CONFIGS.position_trading.updateFrequencyMs
      );
    });

    it('signal TTL increases from scalping to position', () => {
      expect(STYLE_CONFIGS.scalping.signalTTLSeconds).toBeLessThan(
        STYLE_CONFIGS.day_trading.signalTTLSeconds
      );
      expect(STYLE_CONFIGS.day_trading.signalTTLSeconds).toBeLessThan(
        STYLE_CONFIGS.swing_trading.signalTTLSeconds
      );
      expect(STYLE_CONFIGS.swing_trading.signalTTLSeconds).toBeLessThan(
        STYLE_CONFIGS.position_trading.signalTTLSeconds
      );
    });

    it('EMA fast period increases from scalping to position', () => {
      expect(STYLE_CONFIGS.scalping.config.ema.fast).toBeLessThan(
        STYLE_CONFIGS.day_trading.config.ema.fast
      );
      expect(STYLE_CONFIGS.day_trading.config.ema.fast).toBeLessThan(
        STYLE_CONFIGS.swing_trading.config.ema.fast
      );
      expect(STYLE_CONFIGS.swing_trading.config.ema.fast).toBeLessThan(
        STYLE_CONFIGS.position_trading.config.ema.fast
      );
    });
  });

  describe('getStyleConfig', () => {
    it('returns the correct profile for each style', () => {
      const styles: TradingStyle[] = [
        'scalping',
        'day_trading',
        'swing_trading',
        'position_trading',
      ];
      for (const style of styles) {
        expect(getStyleConfig(style)).toBe(STYLE_CONFIGS[style]);
      }
    });
  });

  describe('shouldSkipIndicator', () => {
    it('returns true for ichimoku in scalping', () => {
      expect(shouldSkipIndicator('scalping', 'ichimoku')).toBe(true);
    });

    it('returns false for ichimoku in other styles', () => {
      expect(shouldSkipIndicator('day_trading', 'ichimoku')).toBe(false);
      expect(shouldSkipIndicator('swing_trading', 'ichimoku')).toBe(false);
      expect(shouldSkipIndicator('position_trading', 'ichimoku')).toBe(false);
    });

    it('returns false for non-skipped indicators', () => {
      expect(shouldSkipIndicator('scalping', 'rsi')).toBe(false);
      expect(shouldSkipIndicator('scalping', 'macd')).toBe(false);
    });
  });

  describe('TRADING_STYLES', () => {
    it('contains all four styles in order', () => {
      expect(TRADING_STYLES).toEqual([
        'scalping',
        'day_trading',
        'swing_trading',
        'position_trading',
      ]);
    });
  });
});
