import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CrossSectionalPortfolioCard } from './CrossSectionalPortfolioCard';
import * as useSignalsHooks from '@/hooks/useSignals';

describe('CrossSectionalPortfolioCard', () => {
  it('renders loading shimmer when loading', () => {
    vi.spyOn(useSignalsHooks, 'useCrossSectionalLatest').mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useSignalsHooks.useCrossSectionalLatest>);

    const { container } = render(<CrossSectionalPortfolioCard />);
    expect(container.querySelector('.animate-shimmer')).toBeInTheDocument();
  });

  it('renders awaiting state when signal is not yet available', () => {
    vi.spyOn(useSignalsHooks, 'useCrossSectionalLatest').mockReturnValue({
      data: { signal: null, book: null },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useSignalsHooks.useCrossSectionalLatest>);

    render(<CrossSectionalPortfolioCard />);
    expect(screen.getByText('8-Hour Cross-Sectional Relative Value Portfolio')).toBeInTheDocument();
    expect(
      screen.getByText(/Awaiting first 8-hour settlement cycle snapshot/)
    ).toBeInTheDocument();
  });

  it('renders populated state with metrics, legs, and expandable rankings', () => {
    const mockData = {
      signal: {
        timestamp: 1760000000000,
        isoTime: '2026-10-12T00:00:00.000Z',
        netBetaExposure: 0.00,
        grossExposure: 1.00,
        longCount: 2,
        shortCount: 2,
        targets: [
          { symbol: 'BTCUSDT', weight: 0.261, side: 'long', targetNotional: 2610, rank: 1 },
          { symbol: 'AVAXUSDT', weight: 0.261, side: 'long', targetNotional: 2610, rank: 2 },
          { symbol: 'SOLUSDT', weight: -0.239, side: 'short', targetNotional: -2390, rank: 9 },
          { symbol: 'DOGEUSDT', weight: -0.239, side: 'short', targetNotional: -2390, rank: 10 },
        ],
        snapshots: [
          { symbol: 'BTCUSDT', close: 65000, fundingRate: 0.0001, betaToBtc: 1.0, return14d: 0.05, btcReturn14d: 0.05, takerBuyRatio: 0.52 },
          { symbol: 'AVAXUSDT', close: 30, fundingRate: -0.0002, betaToBtc: 1.0, return14d: 0.08, btcReturn14d: 0.05, takerBuyRatio: 0.51 },
          { symbol: 'SOLUSDT', close: 150, fundingRate: 0.0005, betaToBtc: 1.09, return14d: -0.02, btcReturn14d: 0.05, takerBuyRatio: 0.48 },
          { symbol: 'DOGEUSDT', close: 0.15, fundingRate: 0.0004, betaToBtc: 1.09, return14d: -0.04, btcReturn14d: 0.05, takerBuyRatio: 0.47 },
        ],
        ranks: [
          { symbol: 'BTCUSDT', rank: 1, compositeZ: 0.85, zMom: 1.2, zIdio: 0.9, zCarry: 0.5, zFlow: 0.2 },
          { symbol: 'AVAXUSDT', rank: 2, compositeZ: 0.75, zMom: 1.1, zIdio: 0.8, zCarry: 0.4, zFlow: 0.1 },
          { symbol: 'SOLUSDT', rank: 9, compositeZ: -0.65, zMom: -1.0, zIdio: -0.7, zCarry: -0.3, zFlow: -0.2 },
          { symbol: 'DOGEUSDT', rank: 10, compositeZ: -0.80, zMom: -1.2, zIdio: -0.8, zCarry: -0.4, zFlow: -0.3 },
        ],
      },
      book: {
        equityMaker: 10150.25,
        equityTaker: 9980.50,
        startEquity: 10000,
        cash: 10000,
        realizedPnlMaker: 150.25,
        realizedPnlTaker: -19.50,
        totalFeesMaker: 12.50,
        totalFeesTaker: 45.20,
        totalFundingReceived: 8.40,
        rebalanceCount: 5,
        positions: [],
      },
    };

    vi.spyOn(useSignalsHooks, 'useCrossSectionalLatest').mockReturnValue({
      data: mockData,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useSignalsHooks.useCrossSectionalLatest>);

    render(<CrossSectionalPortfolioCard />);

    // Header & badges
    expect(screen.getByText('8-Hour Cross-Sectional Relative Value Portfolio')).toBeInTheDocument();
    expect(screen.getByText('Net Beta: 0.00')).toBeInTheDocument();
    expect(screen.getByText('Gross: 1.0x')).toBeInTheDocument();
    expect(screen.getByText('Buffer: 2')).toBeInTheDocument();

    // Dual track equity
    expect(screen.getByText('$10,150.25')).toBeInTheDocument();
    expect(screen.getByText('$9,980.50')).toBeInTheDocument();

    // Active legs
    expect(screen.getByText('BTCUSDT')).toBeInTheDocument();
    expect(screen.getAllByText('+26.10%')).toHaveLength(2);
    expect(screen.getByText('SOLUSDT')).toBeInTheDocument();
    expect(screen.getAllByText('-23.90%')).toHaveLength(2);

    // Toggle factor drawer
    const toggleButton = screen.getByRole('button', { name: /Show Full Cross-Sectional Factor Rankings/i });
    expect(toggleButton).toBeInTheDocument();
    fireEvent.click(toggleButton);

    expect(screen.getByText('Composite Z')).toBeInTheDocument();
    expect(screen.getByText('#1')).toBeInTheDocument();
  });
});
