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
});
