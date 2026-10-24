import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LabSummary } from './LabSummary';

describe('LabSummary', () => {
  it('renders "0 validated" and "No idea has been validated yet." when none validated', () => {
    render(
      <LabSummary
        counts={{
          validated: 0,
          underTest: 13,
          rejected: 1,
          notStarted: 0,
        }}
      />
    );

    expect(screen.getByText('0 validated')).toBeInTheDocument();
    expect(screen.getByText('No idea has been validated yet.')).toBeInTheDocument();
    expect(
      screen.getByText('Evidence is updated every hour at 20 minutes past.')
    ).toBeInTheDocument();
  });

  it('renders "1 validated" without "No idea has been validated yet." when one is validated', () => {
    render(
      <LabSummary
        counts={{
          validated: 1,
          underTest: 12,
          rejected: 1,
          notStarted: 0,
        }}
      />
    );

    expect(screen.getByText('1 validated')).toBeInTheDocument();
    expect(screen.queryByText('No idea has been validated yet.')).not.toBeInTheDocument();
  });

  it('renders IdeaCells with counts across labs and rejected rule', () => {
    render(
      <LabSummary
        counts={{
          validated: 2,
          underTest: 5,
          rejected: 1,
          notStarted: 1,
        }}
      />
    );

    const cells = screen.getAllByTestId('idea-cell');
    expect(cells).toHaveLength(9);
  });

  it('renders the same number of rows and data-testid slots in loading state as loaded state', () => {
    const counts = {
      validated: 0,
      underTest: 13,
      rejected: 1,
      notStarted: 0,
    };

    const { container: loadedContainer } = render(
      <LabSummary counts={counts} />
    );
    const loadedSlots = screen.getAllByTestId('idea-cell');
    const loadedRows = loadedContainer.querySelector('section')?.children;

    expect(loadedSlots).toHaveLength(14);
    expect(loadedRows).toHaveLength(4);

    const { container: loadingContainer } = render(
      <LabSummary counts={counts} isLoading />
    );
    // 14 from loaded + 14 from loading = 28 total
    const allSlots = screen.getAllByTestId('idea-cell');
    expect(allSlots).toHaveLength(28);

    const loadingRows = loadingContainer.querySelector('section')?.children;
    expect(loadingRows).toHaveLength(loadedRows?.length ?? 0);
  });

  it('renders 14 placeholder slots when loading without counts', () => {
    const { container } = render(<LabSummary isLoading />);

    const slots = screen.getAllByTestId('idea-cell');
    expect(slots).toHaveLength(14);

    const section = container.querySelector('section');
    expect(section?.children).toHaveLength(4);

    for (const slot of slots) {
      expect(slot).toHaveClass('bg-muted', 'animate-pulse');
      expect(slot).toHaveAttribute('data-kind', 'loading');
    }
  });

  it('renders the same number of rows and slots when one idea is validated', () => {
    const counts = {
      validated: 1,
      underTest: 12,
      rejected: 1,
      notStarted: 0,
    };

    const { container: loadedContainer } = render(
      <LabSummary counts={counts} />
    );
    const loadedRows = loadedContainer.querySelector('section')?.children;
    expect(loadedRows).toHaveLength(3);

    const { container: loadingContainer } = render(
      <LabSummary counts={counts} isLoading />
    );
    const loadingRows = loadingContainer.querySelector('section')?.children;
    expect(loadingRows).toHaveLength(3);
  });
});
