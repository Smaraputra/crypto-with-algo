import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LabGlance } from './LabGlance';
import { useLabSummary } from '@/components/lab/useLabSummary';

vi.mock('@/components/lab/useLabSummary', () => ({
  useLabSummary: vi.fn(),
}));

describe('LabGlance', () => {
  const refetchFailedMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders counts, validated chip, and link to /lab', () => {
    vi.mocked(useLabSummary).mockReturnValue({
      counts: {
        underTest: 6,
        rejected: 1,
        validated: 1,
        notStarted: 0,
      },
      isLoading: false,
      isError: false,
      refetchFailed: refetchFailedMock,
    });

    render(<LabGlance />);

    expect(screen.getByText('Lab')).toBeInTheDocument();
    expect(screen.getByText('6 under test, 1 validated.')).toBeInTheDocument();
    expect(
      screen.getByText('Evidence is updated every hour at 20 minutes past.')
    ).toBeInTheDocument();
    expect(screen.getByText('Validated')).toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'Open the lab record' });
    expect(link).toHaveAttribute('href', '/lab');
  });

  it('chooses "under-test" chip when underTest > 0 and validated is 0', () => {
    vi.mocked(useLabSummary).mockReturnValue({
      counts: {
        underTest: 4,
        rejected: 1,
        validated: 0,
        notStarted: 2,
      },
      isLoading: false,
      isError: false,
      refetchFailed: refetchFailedMock,
    });

    render(<LabGlance />);
    expect(screen.getByText('Under test')).toBeInTheDocument();
  });

  it('chooses "not-started" chip when validated and underTest are 0', () => {
    vi.mocked(useLabSummary).mockReturnValue({
      counts: {
        underTest: 0,
        rejected: 1,
        validated: 0,
        notStarted: 5,
      },
      isLoading: false,
      isError: false,
      refetchFailed: refetchFailedMock,
    });

    render(<LabGlance />);
    expect(screen.getByText('Not started')).toBeInTheDocument();
  });

  it('renders loading status when loading', () => {
    vi.mocked(useLabSummary).mockReturnValue({
      counts: { underTest: 0, rejected: 1, validated: 0 },
      isLoading: true,
      isError: false,
      refetchFailed: refetchFailedMock,
    });

    render(<LabGlance />);
    expect(screen.getByText('Loading the lab.')).toBeInTheDocument();
  });

  it('renders error notice and calls refetchFailed when Try again is clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(useLabSummary).mockReturnValue({
      counts: { underTest: 0, rejected: 1, validated: 0 },
      isLoading: false,
      isError: true,
      refetchFailed: refetchFailedMock,
    });

    render(<LabGlance />);
    expect(screen.getByText('The lab did not load.')).toBeInTheDocument();

    const button = screen.getByRole('button', { name: 'Try again' });
    await user.click(button);
    expect(refetchFailedMock).toHaveBeenCalledTimes(1);
  });
});
