import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shouldAutoActivate, executeAutoActivation } from './auto-activation';
import type { ISignalTemplate } from '@/lib/models/signal-template';

// Mock SignalTemplate model
const mockFindOne = vi.fn();
vi.mock('@/lib/models/signal-template', () => ({
  SignalTemplate: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
  },
}));

// Mock activateTemplate
const mockActivateTemplate = vi.fn();
vi.mock('./template-versioning', () => ({
  activateTemplate: (...args: unknown[]) => mockActivateTemplate(...args),
}));

describe('auto-activation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('shouldAutoActivate', () => {
    it('should activate when no current template exists', async () => {
      mockFindOne.mockResolvedValue(null);

      const optimizedTemplate = {
        performanceMetrics: {
          avgSharpe: 1.5,
          totalBacktests: 10,
        },
      } as unknown as ISignalTemplate;

      const result = await shouldAutoActivate('day_trading', optimizedTemplate);

      expect(result.shouldActivate).toBe(true);
      expect(result.reason).toContain('No current active template');
      expect(result.metrics.newSharpe).toBe(1.5);
    });

    it('should activate when Sharpe improves by ≥10%', async () => {
      mockFindOne.mockResolvedValue({
        performanceMetrics: {
          avgSharpe: 1.0,
        },
      });

      const optimizedTemplate = {
        performanceMetrics: {
          avgSharpe: 1.15, // 15% improvement
          totalBacktests: 10,
        },
      } as unknown as ISignalTemplate;

      const result = await shouldAutoActivate('day_trading', optimizedTemplate);

      expect(result.shouldActivate).toBe(true);
      expect(result.reason).toContain('15.0%');
      expect(result.reason).toContain('≥10% threshold');
      expect(result.metrics.currentSharpe).toBe(1.0);
      expect(result.metrics.newSharpe).toBe(1.15);
      expect(result.metrics.improvement).toBeCloseTo(15.0, 1);
    });

    it('should not activate when improvement is below 10%', async () => {
      mockFindOne.mockResolvedValue({
        performanceMetrics: {
          avgSharpe: 1.0,
        },
      });

      const optimizedTemplate = {
        performanceMetrics: {
          avgSharpe: 1.05, // 5% improvement
          totalBacktests: 10,
        },
      } as unknown as ISignalTemplate;

      const result = await shouldAutoActivate('day_trading', optimizedTemplate);

      expect(result.shouldActivate).toBe(false);
      expect(result.reason).toContain('below 10% threshold');
      expect(result.reason).toContain('5.0%');
      expect(result.metrics.improvement).toBeCloseTo(5.0, 1);
    });

    it('should not activate when new template has invalid Sharpe', async () => {
      mockFindOne.mockResolvedValue({
        performanceMetrics: {
          avgSharpe: 1.0,
        },
      });

      const optimizedTemplate = {
        performanceMetrics: {
          avgSharpe: NaN,
          totalBacktests: 10,
        },
      } as unknown as ISignalTemplate;

      const result = await shouldAutoActivate('day_trading', optimizedTemplate);

      expect(result.shouldActivate).toBe(false);
      expect(result.reason).toContain('invalid Sharpe ratio');
    });

    it('should not activate when new template has negative Sharpe', async () => {
      mockFindOne.mockResolvedValue({
        performanceMetrics: {
          avgSharpe: 1.0,
        },
      });

      const optimizedTemplate = {
        performanceMetrics: {
          avgSharpe: -0.5,
          totalBacktests: 10,
        },
      } as unknown as ISignalTemplate;

      const result = await shouldAutoActivate('day_trading', optimizedTemplate);

      expect(result.shouldActivate).toBe(false);
      expect(result.reason).toContain('invalid Sharpe ratio');
    });

    it('should not activate when new template has insufficient backtest results', async () => {
      mockFindOne.mockResolvedValue({
        performanceMetrics: {
          avgSharpe: 1.0,
        },
      });

      const optimizedTemplate = {
        performanceMetrics: {
          avgSharpe: 1.5,
          totalBacktests: 3, // Less than 5
        },
      } as unknown as ISignalTemplate;

      const result = await shouldAutoActivate('day_trading', optimizedTemplate);

      expect(result.shouldActivate).toBe(false);
      expect(result.reason).toContain('Insufficient backtest results');
      expect(result.reason).toContain('3 < 5');
    });

    it('should not activate when new template missing performance metrics', async () => {
      mockFindOne.mockResolvedValue({
        performanceMetrics: {
          avgSharpe: 1.0,
        },
      });

      const optimizedTemplate = {} as unknown as ISignalTemplate;

      const result = await shouldAutoActivate('day_trading', optimizedTemplate);

      expect(result.shouldActivate).toBe(false);
      expect(result.reason).toContain('missing performance metrics');
    });

    it('should activate when current template has invalid Sharpe', async () => {
      mockFindOne.mockResolvedValue({
        performanceMetrics: {
          avgSharpe: NaN,
        },
      });

      const optimizedTemplate = {
        performanceMetrics: {
          avgSharpe: 1.5,
          totalBacktests: 10,
        },
      } as unknown as ISignalTemplate;

      const result = await shouldAutoActivate('day_trading', optimizedTemplate);

      expect(result.shouldActivate).toBe(true);
      expect(result.reason).toContain('Current template has invalid Sharpe');
      expect(result.metrics.improvement).toBe(100);
    });

    it('should activate when current template has zero Sharpe', async () => {
      mockFindOne.mockResolvedValue({
        performanceMetrics: {
          avgSharpe: 0,
        },
      });

      const optimizedTemplate = {
        performanceMetrics: {
          avgSharpe: 1.5,
          totalBacktests: 10,
        },
      } as unknown as ISignalTemplate;

      const result = await shouldAutoActivate('day_trading', optimizedTemplate);

      expect(result.shouldActivate).toBe(true);
      expect(result.reason).toContain('invalid Sharpe');
    });

    it('should calculate improvement correctly for exact 10% threshold', async () => {
      mockFindOne.mockResolvedValue({
        performanceMetrics: {
          avgSharpe: 1.0,
        },
      });

      const optimizedTemplate = {
        performanceMetrics: {
          avgSharpe: 1.1, // Exactly 10% improvement
          totalBacktests: 10,
        },
      } as unknown as ISignalTemplate;

      const result = await shouldAutoActivate('day_trading', optimizedTemplate);

      expect(result.shouldActivate).toBe(true);
      expect(result.metrics.improvement).toBeCloseTo(10.0, 1);
    });

    it('should handle missing totalBacktests (defaults to 0)', async () => {
      mockFindOne.mockResolvedValue(null);

      const optimizedTemplate = {
        performanceMetrics: {
          avgSharpe: 1.5,
          // totalBacktests missing
        },
      } as unknown as ISignalTemplate;

      const result = await shouldAutoActivate('day_trading', optimizedTemplate);

      expect(result.shouldActivate).toBe(false);
      expect(result.reason).toContain('Insufficient backtest results');
    });

    it('should handle current template without performance metrics', async () => {
      mockFindOne.mockResolvedValue({
        // No performanceMetrics field
      });

      const optimizedTemplate = {
        performanceMetrics: {
          avgSharpe: 1.5,
          totalBacktests: 10,
        },
      } as unknown as ISignalTemplate;

      const result = await shouldAutoActivate('day_trading', optimizedTemplate);

      expect(result.shouldActivate).toBe(true);
      expect(result.reason).toContain('invalid Sharpe');
      expect(result.metrics.currentSharpe).toBe(0);
    });
  });

  describe('executeAutoActivation', () => {
    it('should call activateTemplate with correct templateId', async () => {
      const templateId = 'template123' as unknown as Parameters<typeof executeAutoActivation>[0];
      const activatedTemplate = { _id: templateId, active: true } as ISignalTemplate;
      mockActivateTemplate.mockResolvedValue(activatedTemplate);

      const decision = {
        shouldActivate: true,
        reason: 'Test reason',
        metrics: { currentSharpe: 1.0, newSharpe: 1.2, improvement: 20 },
      };

      const result = await executeAutoActivation(templateId, decision);

      expect(mockActivateTemplate).toHaveBeenCalledWith(templateId);
      expect(result).toEqual(activatedTemplate);
    });

    it('should throw error when decision is not to activate', async () => {
      const templateId = 'template123' as unknown as Parameters<typeof executeAutoActivation>[0];

      const decision = {
        shouldActivate: false,
        reason: 'Below threshold',
        metrics: { currentSharpe: 1.0, newSharpe: 1.05, improvement: 5 },
      };

      await expect(executeAutoActivation(templateId, decision)).rejects.toThrow(
        'Cannot activate template: decision was not to activate'
      );

      expect(mockActivateTemplate).not.toHaveBeenCalled();
    });
  });
});
