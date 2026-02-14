import { describe, it, expect, vi, beforeEach } from 'vitest';
import mongoose from 'mongoose';

const mockSignalTemplateCreate = vi.fn();
const mockSignalTemplateFindOne = vi.fn();
const mockSignalTemplateFindById = vi.fn();
const mockSignalTemplateUpdateMany = vi.fn();
const mockBacktestResultUpdateMany = vi.fn();

vi.mock('@/lib/models/signal-template', () => ({
  SignalTemplate: {
    findOne: (...args: unknown[]) => ({
      sort: () => mockSignalTemplateFindOne(...args),
    }),
    findById: (...args: unknown[]) => mockSignalTemplateFindById(...args),
    updateMany: (...args: unknown[]) => mockSignalTemplateUpdateMany(...args),
    create: (...args: unknown[]) => mockSignalTemplateCreate(...args),
  },
}));

vi.mock('@/lib/models/backtest-result-v2', () => ({
  BacktestResultV2: {
    updateMany: (...args: unknown[]) => mockBacktestResultUpdateMany(...args),
  },
}));

import {
  createTemplateVersion,
  activateTemplate,
  markResultsAsContributors,
} from './template-versioning';

describe('template-versioning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createTemplateVersion', () => {
    const weights = {
      trend: 0.30,
      momentum: 0.25,
      volume: 0.15,
      volatility: 0.10,
      futures: 0.10,
      sentiment: 0.10,
    };
    const thresholds = { bullish: 0.6, bearish: -0.6, strong: 0.8 };
    const metrics = { avgSharpe: 1.5, avgWinRate: 0.55, totalBacktests: 10 };

    it('creates version 1 when no existing template', async () => {
      mockSignalTemplateFindOne.mockResolvedValue(null);
      mockSignalTemplateCreate.mockResolvedValue({
        tradingStyle: 'day_trading',
        version: 1,
        weights,
        thresholds,
        active: false,
      });

      const result = await createTemplateVersion(
        'day_trading',
        weights,
        thresholds as never,
        metrics
      );

      expect(result.version).toBe(1);
      expect(result.active).toBe(false);
      expect(mockSignalTemplateCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          tradingStyle: 'day_trading',
          version: 1,
          active: false,
        })
      );
    });

    it('increments version from existing template', async () => {
      mockSignalTemplateFindOne.mockResolvedValue({ version: 3 });
      mockSignalTemplateCreate.mockResolvedValue({
        tradingStyle: 'scalping',
        version: 4,
        weights,
        active: false,
      });

      const result = await createTemplateVersion(
        'scalping',
        weights,
        thresholds as never,
        metrics
      );

      expect(result.version).toBe(4);
      expect(mockSignalTemplateCreate).toHaveBeenCalledWith(
        expect.objectContaining({ version: 4 })
      );
    });

    it('creates template as inactive by default', async () => {
      mockSignalTemplateFindOne.mockResolvedValue(null);
      mockSignalTemplateCreate.mockResolvedValue({
        version: 1,
        active: false,
      });

      await createTemplateVersion('swing_trading', weights, thresholds as never, metrics);

      expect(mockSignalTemplateCreate).toHaveBeenCalledWith(
        expect.objectContaining({ active: false })
      );
    });

    it('passes performance metrics with lastOptimizedAt', async () => {
      mockSignalTemplateFindOne.mockResolvedValue(null);
      mockSignalTemplateCreate.mockImplementation((doc) => doc);

      const result = await createTemplateVersion(
        'day_trading',
        weights,
        thresholds as never,
        metrics
      );

      expect(result.performanceMetrics.avgSharpe).toBe(1.5);
      expect(result.performanceMetrics.avgWinRate).toBe(0.55);
      expect(result.performanceMetrics.totalBacktests).toBe(10);
      expect(result.performanceMetrics.lastOptimizedAt).toBeInstanceOf(Date);
    });
  });

  describe('activateTemplate', () => {
    it('activates target template and deactivates same-style others', async () => {
      const templateId = new mongoose.Types.ObjectId();
      const mockTemplate = {
        _id: templateId,
        tradingStyle: 'day_trading',
        active: false,
        save: vi.fn().mockResolvedValue(undefined),
      };

      mockSignalTemplateFindById.mockResolvedValue(mockTemplate);
      mockSignalTemplateUpdateMany.mockResolvedValue({ modifiedCount: 2 });

      const result = await activateTemplate(templateId);

      // Deactivates other templates of same style
      expect(mockSignalTemplateUpdateMany).toHaveBeenCalledWith(
        { tradingStyle: 'day_trading', _id: { $ne: templateId } },
        { $set: { active: false } }
      );

      // Activates target
      expect(mockTemplate.active).toBe(true);
      expect(mockTemplate.save).toHaveBeenCalled();
      expect(result).toBe(mockTemplate);
    });

    it('throws when template not found', async () => {
      const templateId = new mongoose.Types.ObjectId();
      mockSignalTemplateFindById.mockResolvedValue(null);

      await expect(activateTemplate(templateId)).rejects.toThrow('Template not found');
      expect(mockSignalTemplateUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('markResultsAsContributors', () => {
    it('updates provided result IDs', async () => {
      const ids = [
        new mongoose.Types.ObjectId(),
        new mongoose.Types.ObjectId(),
      ];
      mockBacktestResultUpdateMany.mockResolvedValue({ modifiedCount: 2 });

      await markResultsAsContributors(ids);

      expect(mockBacktestResultUpdateMany).toHaveBeenCalledWith(
        { _id: { $in: ids } },
        { $set: { contributedToTemplate: true } }
      );
    });
  });
});
