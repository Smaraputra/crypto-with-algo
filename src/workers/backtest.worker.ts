import { runBacktest } from '../lib/backtest/engine';
import type { WorkerRequest, WorkerResponse } from '../lib/backtest/worker-types';

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { candles, config, symbol, interval } = event.data;

  try {
    const result = runBacktest(
      candles,
      config,
      symbol,
      interval,
      (progress, barsProcessed, totalBars) => {
        const msg: WorkerResponse = {
          type: 'progress',
          progress,
          barsProcessed,
          totalBars,
        };
        self.postMessage(msg);
      }
    );

    const msg: WorkerResponse = { type: 'complete', result };
    self.postMessage(msg);
  } catch (err) {
    const msg: WorkerResponse = {
      type: 'error',
      message: err instanceof Error ? err.message : 'Backtest failed',
    };
    self.postMessage(msg);
  }
};
