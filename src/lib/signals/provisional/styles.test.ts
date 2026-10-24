import { describe, expect, it } from 'vitest';
import { scoredIntervals, TRADING_STYLES } from '@/lib/indicators/style-configs';
import { isProvisionalEligible, resolveStyle, stylesForInterval, STYLE_CADENCE_MS } from './styles';

describe('provisional styles', () => {
  it('derives styles per interval from the scored intervals', () => {
    // scalping 1m is a retired scoring interval, 5m is still scored
    expect(stylesForInterval('1m')).toEqual([]);
    expect(stylesForInterval('5m')).toEqual(['scalping']);
    expect(isProvisionalEligible('BTCUSDT', '1m', 'scalping')).toBe(false);
    expect(isProvisionalEligible('BTCUSDT', '5m', 'scalping')).toBe(true);
    expect(stylesForInterval('1h')).toEqual(['day_trading']);
    expect(stylesForInterval('1d')).toEqual(['swing_trading', 'position_trading']);
    expect(stylesForInterval('3m')).toEqual([]);
    for (const s of TRADING_STYLES) {
      for (const i of scoredIntervals(s)) {
        expect(stylesForInterval(i)).toContain(s);
      }
    }
  });

  it('is eligible only for a signal symbol, a style and a scored interval', () => {
    expect(isProvisionalEligible('BTCUSDT', '1h', 'day_trading')).toBe(true);
    expect(isProvisionalEligible('BTCUSDT', '1h', 'scalping')).toBe(false);
    expect(isProvisionalEligible('BTCUSDT', '1h', null)).toBe(false);
    expect(isProvisionalEligible('PEPEUSDT', '1h', 'day_trading')).toBe(false);
  });

  it('pins the scheduler cadence per style', () => {
    expect(STYLE_CADENCE_MS).toEqual({
      scalping: 60_000,
      day_trading: 300_000,
      swing_trading: 900_000,
      position_trading: 3_600_000,
    });
  });

  it('resolves the style for a chart interval', () => {
    expect(resolveStyle('15m')).toBe('day_trading');
    expect(resolveStyle('1h')).toBe('day_trading');
    expect(resolveStyle('4h')).toBe('swing_trading');
    expect(resolveStyle('1d')).toBe('swing_trading');
    expect(resolveStyle('1d', 'position_trading')).toBe('position_trading');
    expect(resolveStyle('1w')).toBeNull();
  });
});
