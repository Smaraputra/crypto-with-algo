import { describe, expect, it } from 'vitest';
import {
  isNavActive,
  PRIMARY_NAV_ITEMS,
  MORE_SHEET_ITEMS,
} from './nav-items';

function navItem(label: string) {
  const item = PRIMARY_NAV_ITEMS.find((i) => i.label === label);
  if (!item) throw new Error(`No primary nav item "${label}"`);
  return item;
}

describe('nav-items and isNavActive', () => {
  const marketItem = navItem('Market');
  const signalsItem = navItem('Signals');
  const labItem = navItem('Lab');
  const portfolioItem = navItem('Portfolio');
  const journalItem = navItem('Journal');
  const alertsItem = navItem('Alerts');
  const toolsItem = { label: 'Tools', href: '/cost-check' };

  it('Market is active on /dashboard and /focus', () => {
    expect(isNavActive('/dashboard', marketItem)).toBe(true);
    expect(isNavActive('/focus', marketItem)).toBe(true);
    expect(isNavActive('/focus?symbol=BTCUSDT', marketItem)).toBe(true);
    expect(isNavActive('/signals', marketItem)).toBe(false);

    expect(isNavActive('/lab', marketItem)).toBe(false);
    expect(isNavActive('/portfolio', marketItem)).toBe(false);
  });

  it('Signals is active on /signals', () => {
    expect(isNavActive('/signals', signalsItem)).toBe(true);
    expect(isNavActive('/signals/score', signalsItem)).toBe(true);
    expect(isNavActive('/signals?status=rejected', signalsItem)).toBe(true);

    expect(isNavActive('/dashboard', signalsItem)).toBe(false);
    expect(isNavActive('/lab', signalsItem)).toBe(false);
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

  it('More sheet contains Notes pointing to /notes and no Analytics', () => {
    const notes = MORE_SHEET_ITEMS.find((i) => i.label === 'Notes')!;
    expect(notes.href).toBe('/notes');

    expect(MORE_SHEET_ITEMS.find((i) => i.label === 'Analytics')).toBeUndefined();
  });
});
