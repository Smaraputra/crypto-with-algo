import { describe, expect, it } from 'vitest';
import {
  isNavActive,
  PRIMARY_NAV_ITEMS,
  TOOLS_INTERIM_ITEMS,
  MORE_SHEET_ITEMS,
} from './nav-items';

describe('nav-items and isNavActive', () => {
  const marketItem = PRIMARY_NAV_ITEMS.find((i) => i.label === 'Market')!;
  const labItem = PRIMARY_NAV_ITEMS.find((i) => i.label === 'Lab')!;
  const portfolioItem = PRIMARY_NAV_ITEMS.find((i) => i.label === 'Portfolio')!;
  const journalItem = PRIMARY_NAV_ITEMS.find((i) => i.label === 'Journal')!;
  const alertsItem = PRIMARY_NAV_ITEMS.find((i) => i.label === 'Alerts')!;
  const toolsItem = { label: 'Tools', href: '/cost-check' };

  it('Market is active on /dashboard, /focus and /signals', () => {
    expect(isNavActive('/dashboard', marketItem)).toBe(true);
    expect(isNavActive('/focus', marketItem)).toBe(true);
    expect(isNavActive('/focus?symbol=BTCUSDT', marketItem)).toBe(true);
    expect(isNavActive('/signals', marketItem)).toBe(true);

    expect(isNavActive('/lab', marketItem)).toBe(false);
    expect(isNavActive('/portfolio', marketItem)).toBe(false);
  });

  it('Lab is active on /lab', () => {
    expect(isNavActive('/lab', labItem)).toBe(true);
    expect(isNavActive('/lab/candidate-1', labItem)).toBe(true);

    expect(isNavActive('/dashboard', labItem)).toBe(false);
    expect(isNavActive('/portfolio', labItem)).toBe(false);
  });

  it('Portfolio is active on /portfolio and /analytics', () => {
    expect(isNavActive('/portfolio', portfolioItem)).toBe(true);
    expect(isNavActive('/analytics', portfolioItem)).toBe(true);

    expect(isNavActive('/journal', portfolioItem)).toBe(false);
    expect(isNavActive('/lab', portfolioItem)).toBe(false);
  });

  it('Journal is active on /journal, /research and /notes', () => {
    expect(isNavActive('/journal', journalItem)).toBe(true);
    expect(isNavActive('/research', journalItem)).toBe(true);
    expect(isNavActive('/notes', journalItem)).toBe(true);

    expect(isNavActive('/dashboard', journalItem)).toBe(false);
    expect(isNavActive('/alerts', journalItem)).toBe(false);
  });

  it('Alerts is active on /alerts', () => {
    expect(isNavActive('/alerts', alertsItem)).toBe(true);

    expect(isNavActive('/dashboard', alertsItem)).toBe(false);
    expect(isNavActive('/cost-check', alertsItem)).toBe(false);
  });

  it('Tools is active on /cost-check and /backtest', () => {
    expect(isNavActive('/cost-check', toolsItem)).toBe(true);
    expect(isNavActive('/backtest', toolsItem)).toBe(true);
    expect(isNavActive('/cost-check', 'Tools')).toBe(true);
    expect(isNavActive('/backtest', 'Tools')).toBe(true);

    expect(isNavActive('/dashboard', toolsItem)).toBe(false);
    expect(isNavActive('/portfolio', toolsItem)).toBe(false);
  });

  it('marks interim items with interim: true and appropriate removalReason', () => {
    const signals = TOOLS_INTERIM_ITEMS.find((i) => i.label === 'Signals')!;
    const notes = TOOLS_INTERIM_ITEMS.find((i) => i.label === 'Notes')!;
    const analytics = TOOLS_INTERIM_ITEMS.find((i) => i.label === 'Analytics')!;

    expect(signals.interim).toBe(true);
    expect(signals.removalReason).toContain('price score link');

    expect(notes.interim).toBe(true);
    expect(notes.removalReason).toContain('Notes switcher');

    expect(analytics.interim).toBe(true);
    expect(analytics.removalReason).toContain('tabs and redirect');

    const moreAnalytics = MORE_SHEET_ITEMS.find((i) => i.label === 'Analytics')!;
    expect(moreAnalytics.interim).toBe(true);
  });
});
