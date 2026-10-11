import { describe, expect, it } from 'vitest';
import type { OHLCV } from '@/types/market';
import type { SignalComponent } from '@/types/signal';
import { prepareBacktest, runOptimizedBacktest } from './optimized-engine';
import { DEFAULT_BACKTEST_CONFIG } from './types';
import type { Strategy, StrategyContext } from './strategy';

const HOUR = 3_600_000;

function series(n: number): OHLCV[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + 5 * Math.sin(i / 9) + i * 0.02;
    return { timestamp: i * HOUR, open: close - 0.2, high: close + 0.6, low: close - 0.6, close, volume: 1000 + (i % 7) * 50 };
  });
}

describe('StrategyContext.components', () => {
  it('carries the scorer components of the bar, whose weighted sum is the composite', () => {
    const seen: Array<{ score: number; components: SignalComponent[] | undefined }> = [];
    const probe: Strategy = {
      name: 'probe',
      decideEntry(ctx: StrategyContext) {
        seen.push({ score: ctx.score, components: ctx.components });
        return null;
      },
      decideExit() {
        return false;
      },
    };
    const prepared = prepareBacktest(series(400), 'BTCUSDT', '1h');
    runOptimizedBacktest(prepared, { ...DEFAULT_BACKTEST_CONFIG }, 'BTCUSDT', '1h', undefined, probe);
    const scored = seen.filter((s) => s.components && s.components.length > 0);
    expect(scored.length).toBeGreaterThan(100);
    for (const s of scored) {
      const sum = (s.components as SignalComponent[]).reduce((acc, c) => acc + c.weightedScore, 0);
      expect(Math.max(-100, Math.min(100, sum))).toBeCloseTo(s.score, 6);
    }
  });
});
