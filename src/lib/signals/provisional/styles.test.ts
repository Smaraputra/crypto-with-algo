import { describe, expect, it } from 'vitest';
import { getStyleConfig, TRADING_STYLES } from '@/lib/indicators/style-configs';
import { isProvisionalEligible, stylesForInterval, STYLE_CADENCE_MS } from './styles';

describe('provisional styles', () => {
  it('derives styles per interval from preferredIntervals', () => {
    expect(stylesForInterval('1m')).toEqual(['scalping']);
    expect(stylesForInterval('1h')).toEqual(['day_trading']);
    expect(stylesForInterval('1d')).toEqual(['swing_trading', 'position_trading']);
    expect(stylesForInterval('3m')).toEqual([]);
    for (const s of TRADING_STYLES) {
      for (const i of getStyleConfig(s).preferredIntervals) {
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
});
