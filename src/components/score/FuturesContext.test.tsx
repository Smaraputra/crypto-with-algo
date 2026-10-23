import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FuturesContext, formatSignedPercentRate } from './FuturesContext';
import {
  useFundingRate,
  useOpenInterest,
  useLongShortRatio,
} from '@/hooks/useFutures';

vi.mock('@/hooks/useFutures', () => ({
  useFundingRate: vi.fn(),
  useOpenInterest: vi.fn(),
  useLongShortRatio: vi.fn(),
}));

describe('FuturesContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('formats funding rate percentage correctly', () => {
    expect(formatSignedPercentRate(0.0001)).toBe('+0.0100%');
    expect(formatSignedPercentRate(-0.00025)).toBe('-0.0250%');
    expect(formatSignedPercentRate(0)).toBe('+0.0000%');
  });

  it('renders each of the three lines when all queries succeed', () => {
    vi.mocked(useFundingRate).mockReturnValue({
      data: {
        fundingRates: [
          {
            symbol: 'BTCUSDT',
            fundingRate: 0.0001,
            fundingTime: 1700000000,
            markPrice: 50000,
          },
        ],
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useFundingRate>);

    vi.mocked(useOpenInterest).mockReturnValue({
      data: {
        openInterest: {
          symbol: 'BTCUSDT',
          openInterest: 150000,
          time: 1700000000,
        },
        history: [
          {
            symbol: 'BTCUSDT',
            sumOpenInterest: 140000,
            sumOpenInterestValue: 7000000000,
            timestamp: 1699990000,
          },
          {
            symbol: 'BTCUSDT',
            sumOpenInterest: 150000,
            sumOpenInterestValue: 7500000000,
            timestamp: 1700000000,
          },
        ],
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useOpenInterest>);

    vi.mocked(useLongShortRatio).mockReturnValue({
      data: {
        longShortRatio: [
          {
            symbol: 'BTCUSDT',
            longShortRatio: 1.45,
            longAccount: 59.18,
            shortAccount: 40.82,
            timestamp: 1700000000,
          },
        ],
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useLongShortRatio>);

    render(<FuturesContext symbol="BTCUSDT" />);

    expect(screen.getByTestId('futures-funding')).toHaveTextContent(
      'Latest funding rate: +0.0100%.'
    );
    expect(screen.getByTestId('futures-oi')).toHaveTextContent(
      'Open interest: 150,000 BTC (+7.14%).'
    );
    expect(screen.getByTestId('futures-ls')).toHaveTextContent(
      'Long to short account ratio: 1.45.'
    );
  });

  it('renders open interest rounded to whole number with base asset unit for float values', () => {
    vi.mocked(useFundingRate).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useFundingRate>);

    vi.mocked(useOpenInterest).mockReturnValue({
      data: {
        openInterest: {
          symbol: 'BTCUSDT',
          openInterest: 95035.309,
          time: 1700000000,
        },
        history: null,
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useOpenInterest>);

    vi.mocked(useLongShortRatio).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useLongShortRatio>);

    render(<FuturesContext symbol="BTCUSDT" />);

    expect(screen.getByTestId('futures-oi')).toHaveTextContent(
      'Open interest: 95,035 BTC.'
    );
  });

  describe('independent errors', () => {
    it('handles funding rate error while others succeed', () => {
      vi.mocked(useFundingRate).mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
      } as unknown as ReturnType<typeof useFundingRate>);

      vi.mocked(useOpenInterest).mockReturnValue({
        data: {
          openInterest: {
            symbol: 'BTCUSDT',
            openInterest: 100000,
            time: 1700000000,
          },
          history: null,
        },
        isLoading: false,
        isError: false,
      } as unknown as ReturnType<typeof useOpenInterest>);

      vi.mocked(useLongShortRatio).mockReturnValue({
        data: {
          longShortRatio: [
            {
              symbol: 'BTCUSDT',
              longShortRatio: 1.2,
              longAccount: 54.5,
              shortAccount: 45.5,
              timestamp: 1700000000,
            },
          ],
        },
        isLoading: false,
        isError: false,
      } as unknown as ReturnType<typeof useLongShortRatio>);

      render(<FuturesContext symbol="BTCUSDT" />);

      expect(screen.getByTestId('futures-funding')).toHaveTextContent(
        'Latest funding rate: Did not load.'
      );
      expect(screen.getByTestId('futures-oi')).toHaveTextContent(
        'Open interest: 100,000 BTC.'
      );
      expect(screen.getByTestId('futures-ls')).toHaveTextContent(
        'Long to short account ratio: 1.20.'
      );
    });

    it('handles open interest error while others succeed', () => {
      vi.mocked(useFundingRate).mockReturnValue({
        data: {
          fundingRates: [
            {
              symbol: 'BTCUSDT',
              fundingRate: 0.0002,
              fundingTime: 1700000000,
              markPrice: 50000,
            },
          ],
        },
        isLoading: false,
        isError: false,
      } as unknown as ReturnType<typeof useFundingRate>);

      vi.mocked(useOpenInterest).mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
      } as unknown as ReturnType<typeof useOpenInterest>);

      vi.mocked(useLongShortRatio).mockReturnValue({
        data: {
          longShortRatio: [
            {
              symbol: 'BTCUSDT',
              longShortRatio: 1.5,
              longAccount: 60,
              shortAccount: 40,
              timestamp: 1700000000,
            },
          ],
        },
        isLoading: false,
        isError: false,
      } as unknown as ReturnType<typeof useLongShortRatio>);

      render(<FuturesContext symbol="BTCUSDT" />);

      expect(screen.getByTestId('futures-funding')).toHaveTextContent(
        'Latest funding rate: +0.0200%.'
      );
      expect(screen.getByTestId('futures-oi')).toHaveTextContent(
        'Open interest: Did not load.'
      );
      expect(screen.getByTestId('futures-ls')).toHaveTextContent(
        'Long to short account ratio: 1.50.'
      );
    });

    it('handles long/short ratio error while others succeed', () => {
      vi.mocked(useFundingRate).mockReturnValue({
        data: {
          fundingRates: [
            {
              symbol: 'BTCUSDT',
              fundingRate: -0.0001,
              fundingTime: 1700000000,
              markPrice: 50000,
            },
          ],
        },
        isLoading: false,
        isError: false,
      } as unknown as ReturnType<typeof useFundingRate>);

      vi.mocked(useOpenInterest).mockReturnValue({
        data: {
          openInterest: {
            symbol: 'BTCUSDT',
            openInterest: 80000,
            time: 1700000000,
          },
          history: null,
        },
        isLoading: false,
        isError: false,
      } as unknown as ReturnType<typeof useOpenInterest>);

      vi.mocked(useLongShortRatio).mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
      } as unknown as ReturnType<typeof useLongShortRatio>);

      render(<FuturesContext symbol="BTCUSDT" />);

      expect(screen.getByTestId('futures-funding')).toHaveTextContent(
        'Latest funding rate: -0.0100%.'
      );
      expect(screen.getByTestId('futures-oi')).toHaveTextContent(
        'Open interest: 80,000 BTC.'
      );
      expect(screen.getByTestId('futures-ls')).toHaveTextContent(
        'Long to short account ratio: Did not load.'
      );
    });
  });
});
