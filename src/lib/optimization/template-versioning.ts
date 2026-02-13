import { SignalTemplate, type TradingStyle, type ISignalTemplate } from '@/lib/models/signal-template';
import { BacktestResultV2 } from '@/lib/models/backtest-result-v2';
import type { SignalWeights } from '@/types/signal';
import mongoose from 'mongoose';

/**
 * Create new template version from optimization
 * Deactivates previous version, sets new as inactive (manual activation)
 */
export async function createTemplateVersion(
  tradingStyle: TradingStyle,
  weights: SignalWeights,
  thresholds: ISignalTemplate['thresholds'],
  performanceMetrics: {
    avgSharpe: number;
    avgWinRate: number;
    totalBacktests: number;
  }
): Promise<ISignalTemplate> {
  // Find current active template for this trading style
  const currentTemplate = await SignalTemplate.findOne({
    tradingStyle,
  }).sort({ version: -1 });

  const nextVersion = currentTemplate ? currentTemplate.version + 1 : 1;

  // Create new template version (inactive by default)
  const newTemplate = await SignalTemplate.create({
    tradingStyle,
    version: nextVersion,
    weights,
    thresholds,
    performanceMetrics: {
      avgSharpe: performanceMetrics.avgSharpe,
      avgWinRate: performanceMetrics.avgWinRate,
      totalBacktests: performanceMetrics.totalBacktests,
      lastOptimizedAt: new Date(),
    },
    active: false, // Requires manual activation
  });

  return newTemplate;
}

/**
 * Activate template version (admin action)
 * Deactivates all other templates for the same trading style
 */
export async function activateTemplate(templateId: mongoose.Types.ObjectId): Promise<ISignalTemplate> {
  const template = await SignalTemplate.findById(templateId);

  if (!template) {
    throw new Error('Template not found');
  }

  // Deactivate all other templates for this trading style
  await SignalTemplate.updateMany(
    {
      tradingStyle: template.tradingStyle,
      _id: { $ne: templateId },
    },
    { $set: { active: false } }
  );

  // Activate target template
  template.active = true;
  await template.save();

  return template;
}

/**
 * Mark backtest results as contributors to template
 */
export async function markResultsAsContributors(
  resultIds: mongoose.Types.ObjectId[]
): Promise<void> {
  await BacktestResultV2.updateMany(
    { _id: { $in: resultIds } },
    { $set: { contributedToTemplate: true } }
  );
}
