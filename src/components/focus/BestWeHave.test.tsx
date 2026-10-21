import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BestWeHave } from './BestWeHave';

const {
  mockUseSignalLabV3,
  mockUseSignalLabV2,
  mockUseSignalLab,
} = vi.hoisted(() => ({
  mockUseSignalLabV3: vi.fn(),
  mockUseSignalLabV2: vi.fn(),
  mockUseSignalLab: vi.fn(),
}));

vi.mock('@/hooks/useSignalLabV3', () => ({
  useSignalLabV3: () => mockUseSignalLabV3(),
}));

vi.mock('@/hooks/useSignalLabV2', () => ({
  useSignalLabV2: () => mockUseSignalLabV2(),
}));

vi.mock('@/hooks/useSignalLab', () => ({
  useSignalLab: () => mockUseSignalLab(),
}));

describe('BestWeHave', () => {
  const refetchV3 = vi.fn();
  const refetchV2 = vi.fn();
  const refetchV1 = vi.fn();
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600_000).toISOString();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading states for each lab independently', () => {
    mockUseSignalLabV3.mockReturnValue({
      isLoading: true,
      error: null,
      data: undefined,
      refetch: refetchV3,
    });
    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      error: null,
      data: undefined,
      refetch: refetchV2,
    });
    mockUseSignalLab.mockReturnValue({
      isLoading: true,
      error: null,
      data: undefined,
      refetch: refetchV1,
    });

    render(<BestWeHave symbol="BTCUSDT" />);

    expect(screen.getByText('Loading lab-v3...')).toBeInTheDocument();
    expect(screen.getByText('Loading lab-v1...')).toBeInTheDocument();
    expect(screen.queryByText('Loading lab-v2...')).not.toBeInTheDocument();
  });

  it('renders error state with retry for failing labs without hiding others', () => {
    mockUseSignalLabV3.mockReturnValue({
      isLoading: false,
      error: new Error('V3 failed'),
      data: undefined,
      refetch: refetchV3,
    });
    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v2',
        threshold: 200,
        hypotheses: [
          {
            id: 'N2-1d',
            candidate: 'N2',
            timeframe: '1d',
            status: 'under_test',
            e: 5.0,
            threshold: 200,
            latestBar: {
              barClose: oneHourAgo,
              positions: [{ symbol: 'BTCUSDT', weight: 0.05 }],
              cash: false,
            },
          },
        ],
      },
      refetch: refetchV2,
    });
    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      data: { version: 'lab-v1', threshold: 800, hypotheses: [] },
      refetch: refetchV1,
    });

    render(<BestWeHave symbol="BTCUSDT" />);

    // Error and retry button for V3
    expect(screen.getByText('Could not load lab-v3: V3 failed.')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: 'Retry' });
    expect(retryBtn).toHaveClass('min-h-11');
    fireEvent.click(retryBtn);
    expect(refetchV3).toHaveBeenCalledTimes(1);

    // V2 hypothesis is still rendered!
    expect(screen.getByTestId('best-row-N2-1d')).toBeInTheDocument();
    expect(screen.getByText('Long 0.050')).toBeInTheDocument();
  });

  it('renders empty state when all queries load with no data', () => {
    mockUseSignalLabV3.mockReturnValue({
      isLoading: false,
      error: null,
      data: { version: 'lab-v3', threshold: 200, hypotheses: [] },
      refetch: refetchV3,
    });
    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      error: null,
      data: { version: 'lab-v2', threshold: 200, hypotheses: [] },
      refetch: refetchV2,
    });
    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      data: { version: 'lab-v1', threshold: 800, hypotheses: [] },
      refetch: refetchV1,
    });

    render(<BestWeHave symbol="BTCUSDT" />);

    expect(screen.getByText('No lab hypotheses recorded yet.')).toBeInTheDocument();
  });

  it('sorts rows by e / threshold descending and formats Long, Short, No position, Cash, and Rank', () => {
    mockUseSignalLabV3.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v3',
        threshold: 200,
        hypotheses: [
          {
            id: 'F1-1d',
            candidate: 'F1',
            timeframe: '1d',
            status: 'under_test',
            e: 50.0, // 50 / 200 = 0.25 (should be 2nd)
            threshold: 200,
            latestBar: {
              barClose: oneHourAgo,
              positions: [{ symbol: 'BTCUSDT', weight: 0.064 }],
              cash: false,
            },
          },
        ],
      },
      refetch: refetchV3,
    });

    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v2',
        threshold: 200,
        hypotheses: [
          {
            id: 'N2-1d',
            candidate: 'N2',
            timeframe: '1d',
            status: 'validated',
            e: 100.0, // 100 / 200 = 0.5 (should be 1st)
            threshold: 200,
            latestBar: {
              barClose: oneHourAgo,
              positions: [{ symbol: 'BTCUSDT', weight: -0.064 }],
              cash: false,
            },
          },
          {
            id: 'N3-1d',
            candidate: 'N3',
            timeframe: '1d',
            status: 'under_test',
            e: 10.0, // 10 / 200 = 0.05 (should be 3rd)
            threshold: 200,
            latestBar: {
              barClose: oneHourAgo,
              positions: [{ symbol: 'ETHUSDT', weight: 0.05 }], // BTCUSDT absent -> No position
              cash: false,
            },
          },
        ],
      },
      refetch: refetchV2,
    });

    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v1',
        threshold: 800,
        hypotheses: [
          {
            id: 'L1-8h',
            candidate: 'L1',
            timeframe: '8h',
            status: 'not_started',
            e: 1.84, // 1.84 / 800 = 0.0023 (should be 4th)
            threshold: 800,
            latestBar: {
              barClose: oneHourAgo,
              coins: [
                { symbol: 'ETHUSDT', score: 90, rank: 1 },
                { symbol: 'SOLUSDT', score: 80, rank: 2 },
                { symbol: 'BTCUSDT', score: 70, rank: 3 },
                { symbol: 'DOGEUSDT', score: 60, rank: 4 },
                { symbol: 'XRPUSDT', score: 50, rank: 5 },
                { symbol: 'ADAUSDT', score: 40, rank: 6 },
                { symbol: 'AVAXUSDT', score: 30, rank: 7 },
                { symbol: 'LINKUSDT', score: 20, rank: 8 },
                { symbol: 'DOTUSDT', score: 10, rank: 9 },
                { symbol: 'BNBUSDT', score: 0, rank: 10 },
              ],
            },
          },
        ],
      },
      refetch: refetchV1,
    });

    render(<BestWeHave symbol="BTCUSDT" />);

    const rowN2 = screen.getByTestId('best-row-N2-1d');
    const rowF1 = screen.getByTestId('best-row-F1-1d');
    const rowN3 = screen.getByTestId('best-row-N3-1d');
    const rowL1 = screen.getByTestId('best-row-L1-8h');

    // N2-1d: Short 0.064
    expect(rowN2).toHaveTextContent('N2-1d');
    expect(rowN2).toHaveTextContent('Validated');
    expect(rowN2).toHaveTextContent('Short 0.064');
    expect(rowN2).toHaveTextContent('E 100 of 200');
    expect(rowN2).toHaveTextContent('as of 1h ago');

    // F1-1d: Long 0.064
    expect(rowF1).toHaveTextContent('F1-1d');
    expect(rowF1).toHaveTextContent('Under test');
    expect(rowF1).toHaveTextContent('Long 0.064');
    expect(rowF1).toHaveTextContent('E 50.0 of 200');

    // N3-1d: No position
    expect(rowN3).toHaveTextContent('N3-1d');
    expect(rowN3).toHaveTextContent('No position');

    // L1-8h: Rank 3 of 10, not a direction
    expect(rowL1).toHaveTextContent('L1-8h');
    expect(rowL1).toHaveTextContent('Rank 3 of 10, not a direction');
    expect(rowL1).toHaveTextContent('E 1.84 of 800');

    // Sort order check: N2 (0.5) before F1 (0.25) before N3 (0.05) before L1 (0.0023)
    const allRows = screen.getAllByRole('listitem');
    expect(allRows[0]).toHaveTextContent('N2-1d');
    expect(allRows[1]).toHaveTextContent('F1-1d');
    expect(allRows[2]).toHaveTextContent('N3-1d');
    expect(allRows[3]).toHaveTextContent('L1-8h');
  });

  it('renders Cash when cash is true and not-in-lab-1 line when coin not in lab-v1', () => {
    mockUseSignalLabV3.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v3',
        threshold: 200,
        hypotheses: [
          {
            id: 'F1-1d',
            candidate: 'F1',
            timeframe: '1d',
            status: 'under_test',
            e: 2.5,
            threshold: 200,
            latestBar: {
              barClose: oneHourAgo,
              positions: [{ symbol: 'BTCUSDT', weight: 0.05 }],
              cash: true,
            },
          },
        ],
      },
      refetch: refetchV3,
    });

    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      error: null,
      data: { version: 'lab-v2', threshold: 200, hypotheses: [] },
      refetch: refetchV2,
    });

    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v1',
        threshold: 800,
        hypotheses: [
          {
            id: 'L1-8h',
            candidate: 'L1',
            timeframe: '8h',
            status: 'not_started',
            e: 1.0,
            threshold: 800,
            latestBar: {
              barClose: oneHourAgo,
              coins: [
                { symbol: 'ETHUSDT', score: 90, rank: 1 },
                { symbol: 'SOLUSDT', score: 80, rank: 2 },
              ],
            },
          },
        ],
      },
      refetch: refetchV1,
    });

    render(<BestWeHave symbol="BTCUSDT" />);

    // Cash precedence
    const rowF1 = screen.getByTestId('best-row-F1-1d');
    expect(rowF1).toHaveTextContent('Cash');
  });

  it('BTCUSDT with no lab rows shows lab-v1 rows reading "No bar yet", and no "Not in lab-v1" line', () => {
    mockUseSignalLabV3.mockReturnValue({
      isLoading: false,
      error: null,
      data: { version: 'lab-v3', threshold: 200, hypotheses: [] },
      refetch: refetchV3,
    });
    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      error: null,
      data: { version: 'lab-v2', threshold: 200, hypotheses: [] },
      refetch: refetchV2,
    });
    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v1',
        threshold: 800,
        hypotheses: [
          {
            id: 'L1-8h',
            candidate: 'L1',
            timeframe: '8h',
            status: 'not_started',
            e: 1.0,
            threshold: 800,
            latestBar: null,
          },
        ],
      },
      refetch: refetchV1,
    });

    render(<BestWeHave symbol="BTCUSDT" />);

    const rowL1 = screen.getByTestId('best-row-L1-8h');
    expect(rowL1).toHaveTextContent('L1-8h');
    expect(rowL1).toHaveTextContent('No bar yet');
    expect(rowL1).toHaveTextContent('as of n/a');
    expect(screen.queryByText("Not in lab-v1's 10 coins")).not.toBeInTheDocument();
  });

  it('PEPEUSDT (not in the 10) shows the not-in-lab-1 line and "Not in this lab\'s coins" for lab-v2 and lab-v3', () => {
    mockUseSignalLabV3.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v3',
        threshold: 200,
        hypotheses: [
          {
            id: 'F1-1d',
            candidate: 'F1',
            timeframe: '1d',
            status: 'under_test',
            e: 2.5,
            threshold: 200,
            latestBar: {
              barClose: oneHourAgo,
              positions: [{ symbol: 'BTCUSDT', weight: 0.05 }],
              cash: false,
            },
          },
        ],
      },
      refetch: refetchV3,
    });
    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v2',
        threshold: 200,
        hypotheses: [
          {
            id: 'N2-1d',
            candidate: 'N2',
            timeframe: '1d',
            status: 'under_test',
            e: 5.0,
            threshold: 200,
            latestBar: {
              barClose: oneHourAgo,
              positions: [{ symbol: 'BTCUSDT', weight: 0.05 }],
              cash: false,
            },
          },
        ],
      },
      refetch: refetchV2,
    });
    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v1',
        threshold: 800,
        hypotheses: [
          {
            id: 'L1-8h',
            candidate: 'L1',
            timeframe: '8h',
            status: 'not_started',
            e: 1.0,
            threshold: 800,
            latestBar: {
              barClose: oneHourAgo,
              coins: [{ symbol: 'BTCUSDT', score: 90, rank: 1 }],
            },
          },
        ],
      },
      refetch: refetchV1,
    });

    render(<BestWeHave symbol="PEPEUSDT" />);

    // Lab-v1 shows the line, and no L1 row
    expect(screen.getByText("Not in lab-v1's 10 coins")).toBeInTheDocument();
    expect(screen.queryByTestId('best-row-L1-8h')).not.toBeInTheDocument();

    // Lab-v2 and Lab-v3 show "Not in this lab's coins"
    const rowN2 = screen.getByTestId('best-row-N2-1d');
    expect(rowN2).toHaveTextContent("Not in this lab's coins");

    const rowF1 = screen.getByTestId('best-row-F1-1d');
    expect(rowF1).toHaveTextContent("Not in this lab's coins");
  });

  it('renders "No bar yet" rather than "No position" when a hypothesis has no latest bar', () => {
    mockUseSignalLabV3.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v3',
        threshold: 200,
        hypotheses: [
          {
            id: 'F1-1d',
            candidate: 'F1',
            timeframe: '1d',
            status: 'under_test',
            e: 2.5,
            threshold: 200,
            latestBar: null,
          },
        ],
      },
      refetch: refetchV3,
    });
    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v2',
        threshold: 200,
        hypotheses: [
          {
            id: 'N2-1d',
            candidate: 'N2',
            timeframe: '1d',
            status: 'under_test',
            e: 5.0,
            threshold: 200,
            latestBar: null,
          },
        ],
      },
      refetch: refetchV2,
    });
    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      data: { version: 'lab-v1', threshold: 800, hypotheses: [] },
      refetch: refetchV1,
    });

    render(<BestWeHave symbol="BTCUSDT" />);

    const rowF1 = screen.getByTestId('best-row-F1-1d');
    expect(rowF1).toHaveTextContent('No bar yet');
    expect(rowF1).toHaveTextContent('as of n/a');

    const rowN2 = screen.getByTestId('best-row-N2-1d');
    expect(rowN2).toHaveTextContent('No bar yet');
    expect(rowN2).toHaveTextContent('as of n/a');
  });

  it('with 11 rows, renders 4 rows and "Show all 11" button; clicking shows all 11 and "Show fewer"', () => {
    mockUseSignalLabV3.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v3',
        threshold: 200,
        hypotheses: [
          {
            id: 'F1-1d',
            candidate: 'F1',
            timeframe: '1d',
            status: 'under_test',
            e: 50.0,
            threshold: 200,
            latestBar: {
              barClose: oneHourAgo,
              positions: [{ symbol: 'BTCUSDT', weight: 0.05 }],
              cash: false,
            },
          },
        ],
      },
      refetch: refetchV3,
    });

    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v2',
        threshold: 200,
        hypotheses: [
          {
            id: 'N2-1d',
            candidate: 'N2',
            timeframe: '1d',
            status: 'under_test',
            e: 40.0,
            threshold: 200,
            latestBar: {
              barClose: oneHourAgo,
              positions: [{ symbol: 'BTCUSDT', weight: 0.05 }],
              cash: false,
            },
          },
          {
            id: 'N3-1d',
            candidate: 'N3',
            timeframe: '1d',
            status: 'under_test',
            e: 30.0,
            threshold: 200,
            latestBar: {
              barClose: oneHourAgo,
              positions: [{ symbol: 'BTCUSDT', weight: 0.05 }],
              cash: false,
            },
          },
        ],
      },
      refetch: refetchV2,
    });

    const lab1Hypotheses = Array.from({ length: 8 }, (_, i) => ({
      id: `L${i + 1}-8h`,
      candidate: `L${i + 1}`,
      timeframe: '8h',
      status: 'not_started',
      e: 10.0 - i,
      threshold: 800,
      latestBar: {
        barClose: oneHourAgo,
        coins: [{ symbol: 'BTCUSDT', score: 80 - i, rank: i + 1 }],
      },
    }));

    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v1',
        threshold: 800,
        hypotheses: lab1Hypotheses,
      },
      refetch: refetchV1,
    });

    render(<BestWeHave symbol="BTCUSDT" />);

    // Initially with 11 rows, only 4 render and the button reads "Show all 11"
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    const toggleButton = screen.getByRole('button', { name: 'Show all 11' });
    expect(toggleButton).toBeInTheDocument();
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    expect(toggleButton).toHaveClass('min-h-11');

    // Clicking reveals all 11 with aria-expanded true and reads "Show fewer"
    fireEvent.click(toggleButton);
    expect(screen.getAllByRole('listitem')).toHaveLength(11);
    expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
    expect(toggleButton).toHaveTextContent('Show fewer');

    // Clicking again collapses back to 4
    fireEvent.click(toggleButton);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    expect(toggleButton).toHaveTextContent('Show all 11');
  });

  it('with 3 rows, there is no button', () => {
    mockUseSignalLabV3.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v3',
        threshold: 200,
        hypotheses: [
          {
            id: 'F1-1d',
            candidate: 'F1',
            timeframe: '1d',
            status: 'under_test',
            e: 50.0,
            threshold: 200,
            latestBar: {
              barClose: oneHourAgo,
              positions: [{ symbol: 'BTCUSDT', weight: 0.05 }],
              cash: false,
            },
          },
        ],
      },
      refetch: refetchV3,
    });

    mockUseSignalLabV2.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v2',
        threshold: 200,
        hypotheses: [
          {
            id: 'N2-1d',
            candidate: 'N2',
            timeframe: '1d',
            status: 'under_test',
            e: 40.0,
            threshold: 200,
            latestBar: {
              barClose: oneHourAgo,
              positions: [{ symbol: 'BTCUSDT', weight: 0.05 }],
              cash: false,
            },
          },
          {
            id: 'N3-1d',
            candidate: 'N3',
            timeframe: '1d',
            status: 'under_test',
            e: 30.0,
            threshold: 200,
            latestBar: {
              barClose: oneHourAgo,
              positions: [{ symbol: 'BTCUSDT', weight: 0.05 }],
              cash: false,
            },
          },
        ],
      },
      refetch: refetchV2,
    });

    mockUseSignalLab.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        version: 'lab-v1',
        threshold: 800,
        hypotheses: [],
      },
      refetch: refetchV1,
    });

    render(<BestWeHave symbol="BTCUSDT" />);

    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /show all/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show fewer/i })).not.toBeInTheDocument();
  });
});
