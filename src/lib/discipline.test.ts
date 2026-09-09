import { describe, it, expect } from 'vitest';
import { evaluateDiscipline, type DisciplineTrade } from './discipline';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// A fixed "now" at 12:00 UTC so today's boundary is stable
const NOW = Math.floor(1700000000000 / DAY) * DAY + 12 * HOUR;

function trade(overrides: Partial<DisciplineTrade> = {}): DisciplineTrade {
  return {
    symbol: 'BTCUSDT',
    createdAt: NOW - HOUR,
    pnlPercent: 1,
    ...overrides,
  };
}

describe('evaluateDiscipline', () => {
  it('returns no nudges for a healthy history', () => {
    const trades = [
      trade({ createdAt: NOW - 3 * HOUR, pnlPercent: 2 }),
      trade({ createdAt: NOW - 2 * HOUR, pnlPercent: -1 }),
      trade({ createdAt: NOW - 1 * HOUR, pnlPercent: 1.5 }),
    ];

    expect(evaluateDiscipline(trades, { now: NOW })).toEqual([]);
  });

  it('warns on a loss cooldown at three consecutive losses', () => {
    const trades = [
      trade({ createdAt: NOW - 4 * HOUR, pnlPercent: 2 }),
      trade({ createdAt: NOW - 3 * HOUR, pnlPercent: -1 }),
      trade({ createdAt: NOW - 2 * HOUR, pnlPercent: -0.5 }),
      trade({ createdAt: NOW - 1 * HOUR, pnlPercent: -2 }),
    ];

    const nudges = evaluateDiscipline(trades, { now: NOW });
    expect(nudges).toHaveLength(1);
    expect(nudges[0].rule).toBe('loss_cooldown');
    expect(nudges[0].severity).toBe('warning');
    expect(nudges[0].message).toContain('3 consecutive losses');
  });

  it('suggests tilt sizing at two consecutive losses', () => {
    const trades = [
      trade({ createdAt: NOW - 2 * HOUR, pnlPercent: -1 }),
      trade({ createdAt: NOW - 1 * HOUR, pnlPercent: -2 }),
    ];

    const nudges = evaluateDiscipline(trades, { now: NOW });
    expect(nudges.map((n) => n.rule)).toEqual(['tilt_sizing']);
    expect(nudges[0].severity).toBe('info');
  });

  it('open trades do not interrupt the closed-loss streak', () => {
    const trades = [
      trade({ createdAt: NOW - 4 * HOUR, pnlPercent: -1 }),
      trade({ createdAt: NOW - 3 * HOUR, pnlPercent: null }), // still open
      trade({ createdAt: NOW - 2 * HOUR, pnlPercent: -1 }),
      trade({ createdAt: NOW - 1 * HOUR, pnlPercent: -1 }),
    ];

    const nudges = evaluateDiscipline(trades, { now: NOW });
    expect(nudges.map((n) => n.rule)).toContain('loss_cooldown');
  });

  it('flags a revenge trade on the same symbol within the window', () => {
    const trades = [
      trade({
        symbol: 'ETHUSDT',
        createdAt: NOW - 2 * HOUR,
        closedAt: NOW - 20 * 60 * 1000,
        pnlPercent: -3,
      }),
    ];

    const nudges = evaluateDiscipline(trades, { now: NOW, candidateSymbol: 'ETHUSDT' });
    expect(nudges.map((n) => n.rule)).toEqual(['revenge_trade']);
    expect(nudges[0].message).toContain('ETHUSDT');
    expect(nudges[0].message).toContain('20 minutes');
  });

  it('does not flag revenge for other symbols, wins, or stale losses', () => {
    const trades = [
      trade({ symbol: 'ETHUSDT', closedAt: NOW - 10 * 60 * 1000, pnlPercent: 2 }), // win
      trade({ symbol: 'SOLUSDT', closedAt: NOW - 10 * 60 * 1000, pnlPercent: -2 }), // other symbol
      trade({ symbol: 'ETHUSDT', createdAt: NOW - 3 * HOUR, closedAt: NOW - 2 * HOUR, pnlPercent: -2 }), // stale
    ];

    expect(evaluateDiscipline(trades, { now: NOW, candidateSymbol: 'ETHUSDT' })).toEqual([]);
  });

  it('flags overtrading when today spikes above the recent average', () => {
    const priorDays = Array.from({ length: 14 }, (_, i) =>
      trade({ createdAt: NOW - (i + 1) * DAY, pnlPercent: 1 })
    ); // 1 per day average
    const today = Array.from({ length: 6 }, (_, i) =>
      trade({ createdAt: NOW - i * 10 * 60 * 1000, pnlPercent: i % 2 === 0 ? 1 : -1 })
    );

    const nudges = evaluateDiscipline([...priorDays, ...today], { now: NOW });
    expect(nudges.map((n) => n.rule)).toContain('overtrading');
  });

  it('needs a minimum count today before calling it overtrading', () => {
    const priorDays = [trade({ createdAt: NOW - 2 * DAY, pnlPercent: 1 })];
    const today = Array.from({ length: 4 }, (_, i) =>
      trade({ createdAt: NOW - i * 10 * 60 * 1000, pnlPercent: 1 })
    );

    const nudges = evaluateDiscipline([...priorDays, ...today], { now: NOW });
    expect(nudges.map((n) => n.rule)).not.toContain('overtrading');
  });

  it('handles empty history', () => {
    expect(evaluateDiscipline([], { now: NOW })).toEqual([]);
  });
});
