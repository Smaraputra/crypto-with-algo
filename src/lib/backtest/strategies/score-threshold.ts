import type { EntryDecision, Strategy, StrategyContext } from '../strategy';
import type { BacktestConfig } from '../types';

/**
 * Today's inline engine rule, re-expressed as a Strategy: enter when the
 * composite score crosses entryThreshold (or shortEntryThreshold with shorts
 * allowed), exit when it falls back through exitThreshold (or
 * shortExitThreshold). Stop and target are fixed percent offsets from the
 * entry bar's close, matching checkStopTakeProfit in trade-utils.ts.
 *
 * Not yet wired into either engine; this only defines the rule.
 */
export function createScoreThresholdStrategy(): Strategy {
  return {
    name: 'score-threshold',

    decideEntry(ctx: StrategyContext, config: BacktestConfig): EntryDecision | null {
      const close = ctx.candles[ctx.bar].close;

      if (ctx.score >= config.entryThreshold) {
        return {
          side: 'long',
          orderType: 'market',
          stopPrice: close * (1 - config.stopLossPercent),
          targetPrice: close * (1 + config.takeProfitPercent),
          timeStopBars: null,
        };
      }

      if (config.allowShorts && ctx.score <= config.shortEntryThreshold) {
        return {
          side: 'short',
          orderType: 'market',
          stopPrice: close * (1 + config.stopLossPercent),
          targetPrice: close * (1 - config.takeProfitPercent),
          timeStopBars: null,
        };
      }

      return null;
    },

    decideExit(ctx: StrategyContext, config: BacktestConfig): boolean {
      if (!ctx.position) return false;

      return (
        (ctx.position.side === 'long' && ctx.score <= config.exitThreshold) ||
        (ctx.position.side === 'short' && ctx.score >= config.shortExitThreshold)
      );
    },
  };
}
