import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CoinEvidencePanel, formatCoinPosition } from './CoinEvidencePanel';
import type { CoinPosition } from '@/lib/signals/lab/coin-evidence';
import type { LabResponse, LabV2Response, LabV3Response, LabV4Response } from '@/lib/signals/lab/view';

const mockUseSignalLab = vi.fn();
const mockUseSignalLabV2 = vi.fn();
const mockUseSignalLabV3 = vi.fn();
const mockUseSignalLabV4 = vi.fn();

vi.mock('@/hooks/useSignalLab', () => ({
  useSignalLab: () => mockUseSignalLab(),
}));

vi.mock('@/hooks/useSignalLabV2', () => ({
  useSignalLabV2: () => mockUseSignalLabV2(),
}));

vi.mock('@/hooks/useSignalLabV3', () => ({
  useSignalLabV3: () => mockUseSignalLabV3(),
}));

vi.mock('@/hooks/useSignalLabV4', () => ({
  useSignalLabV4: () => mockUseSignalLabV4(),
}));

describe('CoinEvidencePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('formatCoinPosition', () => {
    it('formats every position wording according to the brief', () => {
      const p1: CoinPosition = { kind: 'long' };
      expect(formatCoinPosition(p1)).toBe('Holding long');

      const p2: CoinPosition = { kind: 'long', weight: 0.05 };
      expect(formatCoinPosition(p2)).toBe('Holding long 0.050');

      const p3: CoinPosition = {
        kind: 'long',
        until: Date.UTC(2026, 9, 23, 14, 10),
      };
      expect(formatCoinPosition(p3)).toBe('Holding long until 14:10 UTC');

      const p4: CoinPosition = { kind: 'short' };
      expect(formatCoinPosition(p4)).toBe('Holding short');

      const p5: CoinPosition = { kind: 'short', weight: 0.064 };
      expect(formatCoinPosition(p5)).toBe('Holding short 0.064');

      const p6: CoinPosition = {
        kind: 'short',
        until: Date.UTC(2026, 9, 23, 18, 0),
      };
      expect(formatCoinPosition(p6)).toBe('Holding short until 18:00 UTC');

      const p7: CoinPosition = { kind: 'flat' };
      expect(formatCoinPosition(p7)).toBe('No position');

      const p8: CoinPosition = { kind: 'cash' };
      expect(formatCoinPosition(p8)).toBe('In cash');

      const p9: CoinPosition = { kind: 'no_bar' };
      expect(formatCoinPosition(p9)).toBe('No bar yet');

      const p10: CoinPosition = { kind: 'not_in_universe' };
      expect(formatCoinPosition(p10)).toBe("Not in this lab's coins");
    });
  });

  describe('top-4 rule and Show all expansion', () => {
    it('shows only top 4 items initially, then expands when Show all is clicked', async () => {
      const user = userEvent.setup();

      const v1: LabResponse = {
        version: 'lab-v1',
        threshold: 800,
        hypotheses: [
          {
            id: 'L1-8h',
            candidate: 'L1',
            timeframe: '8h',
            status: 'under_test',
            underTestSince: null,
            testEndsAt: null,
            validatedAt: null,
            gradedBars: 10,
            betBars: 10,
            e: 10,
            e0: 0,
            threshold: 800,
            meanX: null,
            meanB: null,
            currentB: null,
            latestBar: { barClose: '2026-10-23T00:00:00Z', late: false, coins: [], skipped: [] },
          },
        ],
      };

      const v2: LabV2Response = {
        version: 'lab-v2',
        threshold: 200,
        hypotheses: [
          {
            id: 'N2-1w',
            candidate: 'N2',
            timeframe: '1w',
            status: 'under_test',
            underTestSince: null,
            testEndsAt: null,
            validatedAt: null,
            gradedBars: 10,
            betBars: 10,
            e: 40,
            threshold: 200,
            absorbed: false,
            meanNetReturn: null,
            lastNetReturn: null,
            scale: 0.1,
            latestBar: { barClose: '2026-10-23T00:00:00Z', late: false, positions: [], cash: false },
          },
          {
            id: 'N3-1d',
            candidate: 'N3',
            timeframe: '1d',
            status: 'under_test',
            underTestSince: null,
            testEndsAt: null,
            validatedAt: null,
            gradedBars: 10,
            betBars: 10,
            e: 30,
            threshold: 200,
            absorbed: false,
            meanNetReturn: null,
            lastNetReturn: null,
            scale: 0.1,
            latestBar: { barClose: '2026-10-23T00:00:00Z', late: false, positions: [], cash: false },
          },
        ],
      };

      const v3: LabV3Response = {
        version: 'lab-v3',
        threshold: 200,
        hypotheses: [
          {
            id: 'F1-1d',
            candidate: 'F1',
            timeframe: '1d',
            status: 'under_test',
            underTestSince: null,
            testEndsAt: null,
            validatedAt: null,
            gradedBars: 10,
            betBars: 10,
            e: 50,
            threshold: 200,
            absorbed: false,
            meanNetReturn: null,
            lastNetReturn: null,
            scale: 0.1,
            latestBar: { barClose: '2026-10-23T00:00:00Z', late: false, positions: [], cash: false },
          },
        ],
      };

      const v4: LabV4Response = {
        version: 'lab-v4',
        threshold: 800,
        hypotheses: [
          {
            id: 'S1-1h',
            candidate: 'S1',
            timeframe: '1h',
            status: 'under_test',
            underTestSince: null,
            testEndsAt: null,
            validatedAt: null,
            gradedBars: 10,
            betBars: 10,
            e: 80,
            threshold: 800,
            absorbed: false,
            meanNetReturn: null,
            lastNetReturn: null,
            scale: 0.1,
            openTrades: [],
            closedTrades: [],
            latestBar: { barClose: '2026-10-23T00:00:00Z', late: false, entries: [] },
          },
          {
            id: 'S2-1h',
            candidate: 'S2',
            timeframe: '1h',
            status: 'under_test',
            underTestSince: null,
            testEndsAt: null,
            validatedAt: null,
            gradedBars: 10,
            betBars: 10,
            e: 70,
            threshold: 800,
            absorbed: false,
            meanNetReturn: null,
            lastNetReturn: null,
            scale: 0.1,
            openTrades: [],
            closedTrades: [],
            latestBar: { barClose: '2026-10-23T00:00:00Z', late: false, entries: [] },
          },
        ],
      };

      mockUseSignalLab.mockReturnValue({ data: v1 });
      mockUseSignalLabV2.mockReturnValue({ data: v2 });
      mockUseSignalLabV3.mockReturnValue({ data: v3 });
      mockUseSignalLabV4.mockReturnValue({ data: v4 });

      render(<CoinEvidencePanel symbol="BTCUSDT" />);

      // Total 6 rows: top 4 visible initially
      expect(screen.getByText('Show all 6')).toBeInTheDocument();

      const showAllBtn = screen.getByRole('button', { name: 'Show all 6' });
      await user.click(showAllBtn);

      expect(screen.queryByText('Show all 6')).not.toBeInTheDocument();
      expect(screen.getByTestId('evidence-row-L1-8h')).toBeInTheDocument();
    });
  });

  describe('chip rule and not-validated line', () => {
    it('shows validated chip when any hypothesis is validated and hides the not-validated line', () => {
      const v2: LabV2Response = {
        version: 'lab-v2',
        threshold: 200,
        hypotheses: [
          {
            id: 'N2-1w',
            candidate: 'N2',
            timeframe: '1w',
            status: 'validated',
            underTestSince: null,
            testEndsAt: null,
            validatedAt: '2026-06-01T00:00:00Z',
            gradedBars: 100,
            betBars: 100,
            e: 200,
            threshold: 200,
            absorbed: false,
            meanNetReturn: null,
            lastNetReturn: null,
            scale: 0.1,
            latestBar: { barClose: '2026-10-23T00:00:00Z', late: false, positions: [], cash: false },
          },
        ],
      };

      mockUseSignalLab.mockReturnValue({ data: undefined });
      mockUseSignalLabV2.mockReturnValue({ data: v2 });
      mockUseSignalLabV3.mockReturnValue({ data: undefined });
      mockUseSignalLabV4.mockReturnValue({ data: undefined });

      render(<CoinEvidencePanel symbol="BTCUSDT" />);

      expect(screen.getByText('Validated')).toBeInTheDocument();
      expect(
        screen.queryByText(
          'None of these ideas is validated. Positions are paper records, not advice.'
        )
      ).not.toBeInTheDocument();
    });

    it('shows under-test chip and the not-validated line when under_test is present but not validated', () => {
      const v4: LabV4Response = {
        version: 'lab-v4',
        threshold: 800,
        hypotheses: [
          {
            id: 'S1-1h',
            candidate: 'S1',
            timeframe: '1h',
            status: 'under_test',
            underTestSince: null,
            testEndsAt: null,
            validatedAt: null,
            gradedBars: 10,
            betBars: 10,
            e: 10,
            threshold: 800,
            absorbed: false,
            meanNetReturn: null,
            lastNetReturn: null,
            scale: 0.1,
            openTrades: [],
            closedTrades: [],
            latestBar: { barClose: '2026-10-23T00:00:00Z', late: false, entries: [] },
          },
        ],
      };

      mockUseSignalLab.mockReturnValue({ data: undefined });
      mockUseSignalLabV2.mockReturnValue({ data: undefined });
      mockUseSignalLabV3.mockReturnValue({ data: undefined });
      mockUseSignalLabV4.mockReturnValue({ data: v4 });

      render(<CoinEvidencePanel symbol="BTCUSDT" />);

      expect(screen.getByText('Under test')).toBeInTheDocument();
      expect(
        screen.getByText(
          'None of these ideas is validated. Positions are paper records, not advice.'
        )
      ).toBeInTheDocument();
    });

    it('shows not-started chip when no row is validated or under_test', () => {
      const v3: LabV3Response = {
        version: 'lab-v3',
        threshold: 200,
        hypotheses: [
          {
            id: 'F1-1d',
            candidate: 'F1',
            timeframe: '1d',
            status: 'not_started',
            underTestSince: null,
            testEndsAt: null,
            validatedAt: null,
            gradedBars: 0,
            betBars: 0,
            e: 0,
            threshold: 200,
            absorbed: false,
            meanNetReturn: null,
            lastNetReturn: null,
            scale: 0.1,
            latestBar: null,
          },
        ],
      };

      mockUseSignalLab.mockReturnValue({ data: undefined });
      mockUseSignalLabV2.mockReturnValue({ data: undefined });
      mockUseSignalLabV3.mockReturnValue({ data: v3 });
      mockUseSignalLabV4.mockReturnValue({ data: undefined });

      render(<CoinEvidencePanel symbol="BTCUSDT" />);

      expect(screen.getByText('Not started')).toBeInTheDocument();
      expect(
        screen.getByText(
          'None of these ideas is validated. Positions are paper records, not advice.'
        )
      ).toBeInTheDocument();
    });
  });

  describe('banned words enforcement', () => {
    it('contains no text matching /\\bbuy\\b|\\bsell\\b|stop|target|leverage/i', () => {
      const v4: LabV4Response = {
        version: 'lab-v4',
        threshold: 800,
        hypotheses: [
          {
            id: 'S1-1h',
            candidate: 'S1',
            timeframe: '1h',
            status: 'under_test',
            underTestSince: null,
            testEndsAt: null,
            validatedAt: null,
            gradedBars: 10,
            betBars: 10,
            e: 10,
            threshold: 800,
            absorbed: false,
            meanNetReturn: null,
            lastNetReturn: null,
            scale: 0.1,
            openTrades: [
              {
                symbol: 'BTCUSDT',
                side: 1,
                enteredAt: '2026-10-23T06:10:00Z',
                exitsAt: '2026-10-23T14:10:00Z',
              },
            ],
            closedTrades: [],
            latestBar: { barClose: '2026-10-23T00:00:00Z', late: false, entries: [] },
          },
        ],
      };

      mockUseSignalLab.mockReturnValue({ data: undefined });
      mockUseSignalLabV2.mockReturnValue({ data: undefined });
      mockUseSignalLabV3.mockReturnValue({ data: undefined });
      mockUseSignalLabV4.mockReturnValue({ data: v4 });

      const { container } = render(<CoinEvidencePanel symbol="BTCUSDT" />);
      const text = container.textContent ?? '';

      expect(text).not.toMatch(/\bbuy\b/i);
      expect(text).not.toMatch(/\bsell\b/i);
      expect(text).not.toMatch(/stop/i);
      expect(text).not.toMatch(/target/i);
      expect(text).not.toMatch(/leverage/i);
    });
  });
});
