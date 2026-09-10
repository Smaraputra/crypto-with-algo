/**
 * Advisory discipline rules over a chronological trade history.
 *
 * Pure and input-generic: journal entries feed it today, paper-bot trades can
 * feed it later. Nudges advise, never block.
 */

export interface DisciplineTrade {
  symbol: string;
  createdAt: number; // entry log time, ms
  closedAt?: number; // close time, ms (when known)
  pnlPercent: number | null; // null = still open or no outcome
}

export interface DisciplineNudge {
  rule: 'loss_cooldown' | 'revenge_trade' | 'overtrading' | 'tilt_sizing';
  severity: 'warning' | 'info';
  message: string;
}

export interface DisciplineOptions {
  now?: number;
  candidateSymbol?: string; // symbol the user is about to trade
}

export const LOSS_COOLDOWN_THRESHOLD = 3;
export const TILT_THRESHOLD = 2;
export const REVENGE_WINDOW_MS = 60 * 60 * 1000;
export const OVERTRADING_MIN_TRADES = 5;
export const OVERTRADING_MULTIPLIER = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

function currentLossStreak(closed: DisciplineTrade[]): number {
  let streak = 0;
  for (let i = closed.length - 1; i >= 0; i--) {
    const pnl = closed[i].pnlPercent!;
    if (pnl < 0) streak++;
    else break;
  }
  return streak;
}

export function evaluateDiscipline(
  trades: DisciplineTrade[],
  options: DisciplineOptions = {}
): DisciplineNudge[] {
  const now = options.now ?? Date.now();
  const nudges: DisciplineNudge[] = [];

  const chronological = [...trades].sort((a, b) => a.createdAt - b.createdAt);
  const closed = chronological.filter((t) => t.pnlPercent !== null);

  // Consecutive losses: cooldown above the threshold, tilt sizing below it
  const lossStreak = currentLossStreak(closed);
  if (lossStreak >= LOSS_COOLDOWN_THRESHOLD) {
    nudges.push({
      rule: 'loss_cooldown',
      severity: 'warning',
      message: `${lossStreak} consecutive losses. Consider stepping away before the next trade.`,
    });
  } else if (lossStreak >= TILT_THRESHOLD) {
    nudges.push({
      rule: 'tilt_sizing',
      severity: 'info',
      message: `${lossStreak} losses in a row. Consider reducing position size until a win.`,
    });
  }

  // Revenge trade: about to re-enter a symbol that just closed at a loss
  if (options.candidateSymbol) {
    const recentLoss = closed
      .filter(
        (t) =>
          t.symbol === options.candidateSymbol &&
          t.pnlPercent! < 0 &&
          now - (t.closedAt ?? t.createdAt) <= REVENGE_WINDOW_MS
      )
      .at(-1);
    if (recentLoss) {
      const minutesAgo = Math.max(
        1,
        Math.round((now - (recentLoss.closedAt ?? recentLoss.createdAt)) / 60000)
      );
      nudges.push({
        rule: 'revenge_trade',
        severity: 'warning',
        message: `You closed a losing ${options.candidateSymbol} trade ${minutesAgo} minute${minutesAgo === 1 ? '' : 's'} ago. Re-entering now can be revenge trading.`,
      });
    }
  }

  // Overtrading: today's entries far above the recent daily average
  const todayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const todayCount = chronological.filter((t) => t.createdAt >= todayStart).length;
  const priorDays = chronological.filter(
    (t) => t.createdAt < todayStart && t.createdAt >= todayStart - 14 * DAY_MS
  );
  if (todayCount >= OVERTRADING_MIN_TRADES && priorDays.length > 0) {
    const dailyAvg = priorDays.length / 14;
    if (todayCount > dailyAvg * OVERTRADING_MULTIPLIER) {
      nudges.push({
        rule: 'overtrading',
        severity: 'info',
        message: `${todayCount} trades logged today versus a ${dailyAvg.toFixed(1)}/day recent average. Quality over quantity.`,
      });
    }
  }

  return nudges;
}
