import { connectDB } from './mongodb';
import {
  SignalTemplate,
  DEFAULT_TEMPLATE_WEIGHTS,
  DEFAULT_TEMPLATE_THRESHOLDS,
  type TradingStyle,
} from './models/signal-template';

/**
 * Seed initial signal templates for all trading styles
 * This is idempotent - only creates templates if they don't exist
 */
export async function seedSignalTemplates(): Promise<void> {
  await connectDB();

  const styles: TradingStyle[] = [
    'scalping',
    'day_trading',
    'swing_trading',
    'position_trading',
  ];

  for (const style of styles) {
    const existing = await SignalTemplate.findOne({
      tradingStyle: style,
      version: 1,
    });

    if (!existing) {
      await SignalTemplate.create({
        tradingStyle: style,
        version: 1,
        weights: DEFAULT_TEMPLATE_WEIGHTS[style],
        thresholds: DEFAULT_TEMPLATE_THRESHOLDS[style],
        performanceMetrics: {
          avgSharpe: 0,
          avgWinRate: 0,
          totalBacktests: 0,
          lastOptimizedAt: null,
        },
        active: true,
      });

      console.log(`Created template for ${style} (v1)`);
    }
  }
}
