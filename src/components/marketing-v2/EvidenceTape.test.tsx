import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EvidenceTape,
  ILLUSTRATIVE_BETS,
  calculateEvidence,
  TAPE_THRESHOLD,
} from './EvidenceTape';
import { usePublicLabCounts } from '@/hooks/usePublicLabCounts';

vi.mock('@/hooks/usePublicLabCounts', () => ({
  usePublicLabCounts: vi.fn(),
}));

const mockPublicCounts = {
  underTest: 12,
  validated: 0,
  notStarted: 1,
  hypotheses: 13,
  rejectedRules: 1,
  ledgerTrials: 2204,
  asOf: '2026-10-24T12:00:00.000Z',
};

describe('EvidenceTape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePublicLabCounts).mockReturnValue({
      data: mockPublicCounts,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePublicLabCounts>);
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it('renders caption, copy, threshold and calculated evidence', () => {
    render(<EvidenceTape />);

    expect(screen.getByText('Illustration, not live data.')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'How evidence builds' })
    ).toBeInTheDocument();

    const expectedEvidence = calculateEvidence(ILLUSTRATIVE_BETS);
    expect(expectedEvidence).toBeLessThan(TAPE_THRESHOLD);
    expect(
      screen.getByText(new RegExp(`${expectedEvidence.toFixed(1)}`))
    ).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Open the lab' })).toHaveAttribute(
      'href',
      '/lab'
    );
  });

  it('under reduced motion no element has an animation class', () => {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { container } = render(<EvidenceTape />);

    const animatedElements = container.querySelectorAll(
      '[class*="animate"], [class*="tape-reveal"]'
    );
    expect(animatedElements).toHaveLength(0);
  });

  it('does not contain banned marketing claims', () => {
    const { container } = render(<EvidenceTape />);
    expect(container.textContent).not.toMatch(
      /guarantee|profit|beat the market|predict|accuracy|win rate|instant|public record|frozen|currently validated/i
    );
  });

  it('renders the live line with counts and plural ideas', () => {
    vi.mocked(usePublicLabCounts).mockReturnValue({
      data: mockPublicCounts,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePublicLabCounts>);

    render(<EvidenceTape />);

    expect(
      screen.getByText(
        'Live now: 12 ideas under test on new market bars, 0 validated so far, and 2,204 trials recorded.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Illustration, not live data.')).toBeInTheDocument();
  });

  it('renders singular idea when underTest count is 1', () => {
    vi.mocked(usePublicLabCounts).mockReturnValue({
      data: {
        ...mockPublicCounts,
        underTest: 1,
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof usePublicLabCounts>);

    render(<EvidenceTape />);

    expect(
      screen.getByText(
        'Live now: 1 idea under test on new market bars, 0 validated so far, and 2,204 trials recorded.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Illustration, not live data.')).toBeInTheDocument();
  });

  it('renders loading placeholders while data is loading', () => {
    vi.mocked(usePublicLabCounts).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof usePublicLabCounts>);

    render(<EvidenceTape />);

    expect(screen.getByTestId('evidence-live-loading')).toBeInTheDocument();
    expect(screen.getAllByTestId('evidence-skeleton-cell')).toHaveLength(14);
    expect(screen.queryByText(/Live now:/)).not.toBeInTheDocument();
    expect(screen.getByText('Illustration, not live data.')).toBeInTheDocument();
  });

  it('hides the block entirely on error while preserving the caption', () => {
    vi.mocked(usePublicLabCounts).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof usePublicLabCounts>);

    render(<EvidenceTape />);

    expect(screen.queryByTestId('evidence-live-block')).not.toBeInTheDocument();
    expect(screen.queryByTestId('evidence-live-loading')).not.toBeInTheDocument();
    expect(screen.queryByText(/Live now:/)).not.toBeInTheDocument();
    expect(screen.getByText('Illustration, not live data.')).toBeInTheDocument();
  });
});
