// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { MARKET_SESSIONS } from '@/lib/sessions';
import { ALL_FAMILIES, EXPLORATION_FAMILIES } from './exploration-families';
import { LEGENDS_FAMILIES } from './families/legends';
import { MAX_GRID_CELLS, STRATEGY_FAMILIES, expandGrid } from './strategy-families';

describe('EXPLORATION_FAMILIES', () => {
  it('registers the thirteen exploration families under their own names', () => {
    expect(Object.keys(EXPLORATION_FAMILIES).sort()).toEqual(
      [
        'vwap-fade',
        'value-area-rejection',
        'sweep-reclaim',
        'sweep-reclaim-limit',
        'bos-continuation',
        'btc-leadlag-continuation',
        'btc-leadlag-continuation-limit',
        'dvol-spike-long',
        'dvol-spike-long-limit',
        'skew-spike-long',
        'delta-flow-continuation',
        'delta-flow-continuation-limit',
        'gamma-regime-reversal',
      ].sort()
    );
    for (const [key, family] of Object.entries(EXPLORATION_FAMILIES)) {
      expect(family.name).toBe(key);
    }
  });

  it('shares no name with STRATEGY_FAMILIES and ALL_FAMILIES is their union', () => {
    const phase4 = Object.keys(STRATEGY_FAMILIES);
    const exploration = Object.keys(EXPLORATION_FAMILIES);
    expect(phase4.filter((name) => exploration.includes(name))).toEqual([]);
    expect(Object.keys(ALL_FAMILIES).length).toBe(phase4.length + exploration.length + Object.keys(LEGENDS_FAMILIES).length);
    expect(ALL_FAMILIES['sweep-reclaim']).toBe(EXPLORATION_FAMILIES['sweep-reclaim']);
    expect(ALL_FAMILIES.control).toBe(STRATEGY_FAMILIES.control);
  });

  it('every exploration family expands to a grid inside the cell cap', () => {
    for (const family of Object.values(EXPLORATION_FAMILIES)) {
      const cells = expandGrid(family);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells.length).toBeLessThanOrEqual(MAX_GRID_CELLS);
    }
  });

  it('the control-session runs can name every market session', () => {
    expect([...MARKET_SESSIONS]).toEqual(['asia', 'london', 'ny_overlap', 'new_york', 'off_hours']);
  });
});
