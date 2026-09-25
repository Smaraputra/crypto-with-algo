import { describe, expect, it } from 'vitest';

import { NO_RATE, formatAvgPnl, avgPnlColorClass } from './format';

describe('formatAvgPnl', () => {
  it('renders a dash when the sample was too small to state an average', () => {
    expect(formatAvgPnl(null)).toBe(NO_RATE);
  });

  it('signs the value so a gain is unambiguous', () => {
    expect(formatAvgPnl(4.2)).toBe('+4.20%');
    expect(formatAvgPnl(-1.5)).toBe('-1.50%');
    expect(formatAvgPnl(0)).toBe('+0.00%');
  });
});

describe('avgPnlColorClass', () => {
  it('does not paint an absent average, which is the bug winRateColorClass already fixed once', () => {
    expect(avgPnlColorClass(null)).toBeUndefined();
  });

  it('colours a real average by sign', () => {
    expect(avgPnlColorClass(0.1)).toBe('text-bullish');
    expect(avgPnlColorClass(-0.1)).toBe('text-bearish');
  });
});
