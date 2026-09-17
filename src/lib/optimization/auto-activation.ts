import { SignalTemplate, type ISignalTemplate, type TradingStyle } from '@/lib/models/signal-template';
import { activateTemplate } from './template-versioning';
import type mongoose from 'mongoose';

export interface ActivationDecision {
  shouldActivate: boolean;
  reason: string;
  metrics: {
    currentSharpe: number;
    newSharpe: number;
    improvement: number; // Percentage
  };
}

/**
 * Determine if optimized template should auto-activate
 * Requires ≥10% Sharpe improvement
 */
export async function shouldAutoActivate(
  tradingStyle: TradingStyle,
  optimizedTemplate: ISignalTemplate
): Promise<ActivationDecision> {
  // Get current active template
  const currentTemplate = await SignalTemplate.findOne({
    tradingStyle,
    active: true,
  });

  // Check if new template has required fields
  if (!optimizedTemplate.performanceMetrics) {
    return {
      shouldActivate: false,
      reason: 'New template missing performance metrics',
      metrics: {
        currentSharpe: 0,
        newSharpe: 0,
        improvement: 0,
      },
    };
  }

  const newSharpe = optimizedTemplate.performanceMetrics.avgSharpe;

  // Check for valid Sharpe ratio
  if (isNaN(newSharpe) || newSharpe <= 0) {
    return {
      shouldActivate: false,
      reason: 'New template has invalid Sharpe ratio',
      metrics: {
        currentSharpe: currentTemplate?.performanceMetrics?.avgSharpe || 0,
        newSharpe: 0,
        improvement: 0,
      },
    };
  }

  // Check minimum backtest results. Both save paths (the monthly
  // orchestrator and the admin optimize-template route) now write the
  // contributing-window count here, not every window or the ensemble size,
  // so this floor counts real out-of-sample tests. Provisional: 3, down
  // from 5, since position_trading's purge gap (a full style/interval
  // indicator warmup skipped between train and test) leaves few enough
  // windows that 5 was unreachable for it; re-measure pending Phase 3.
  // Auto-activation stays disabled in production regardless
  // (OPTIMIZATION_AUTO_ACTIVATE defaults false).
  const totalBacktests = optimizedTemplate.performanceMetrics.totalBacktests || 0;
  const MIN_CONTRIBUTING_WINDOWS = 3;
  if (totalBacktests < MIN_CONTRIBUTING_WINDOWS) {
    return {
      shouldActivate: false,
      reason: `Insufficient backtest results (${totalBacktests} < ${MIN_CONTRIBUTING_WINDOWS})`,
      metrics: {
        currentSharpe: currentTemplate?.performanceMetrics?.avgSharpe || 0,
        newSharpe,
        improvement: 0,
      },
    };
  }

  // No current template - activate if robust
  if (!currentTemplate) {
    return {
      shouldActivate: true,
      reason: 'No current active template - activating first version',
      metrics: {
        currentSharpe: 0,
        newSharpe,
        improvement: 100,
      },
    };
  }

  const currentSharpe = currentTemplate.performanceMetrics?.avgSharpe || 0;

  // Check for valid current Sharpe
  if (isNaN(currentSharpe) || currentSharpe <= 0) {
    return {
      shouldActivate: true,
      reason: 'Current template has invalid Sharpe - replacing',
      metrics: {
        currentSharpe: 0,
        newSharpe,
        improvement: 100,
      },
    };
  }

  // Calculate improvement percentage
  const improvement = ((newSharpe - currentSharpe) / currentSharpe) * 100;

  // Check 10% improvement threshold
  if (improvement >= 10) {
    return {
      shouldActivate: true,
      reason: `Sharpe improved by ${improvement.toFixed(1)}% (≥10% threshold)`,
      metrics: {
        currentSharpe,
        newSharpe,
        improvement,
      },
    };
  }

  return {
    shouldActivate: false,
    reason: `Improvement below 10% threshold (${improvement.toFixed(1)}%)`,
    metrics: {
      currentSharpe,
      newSharpe,
      improvement,
    },
  };
}

/**
 * Execute auto-activation
 * Activates template and returns updated template
 */
export async function executeAutoActivation(
  templateId: mongoose.Types.ObjectId,
  decision: ActivationDecision
): Promise<ISignalTemplate> {
  if (!decision.shouldActivate) {
    throw new Error('Cannot activate template: decision was not to activate');
  }

  // Use existing activation logic
  const activatedTemplate = await activateTemplate(templateId);

  return activatedTemplate;
}
