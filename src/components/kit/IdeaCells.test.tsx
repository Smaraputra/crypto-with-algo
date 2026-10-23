import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IdeaCells } from './IdeaCells';

describe('IdeaCells', () => {
  const counts = {
    underTest: 13,
    rejected: 1,
    validated: 2,
    notStarted: 3,
  };

  it('the cell count equals the sum of counts', () => {
    const totalExpected = counts.underTest + counts.rejected + counts.validated + counts.notStarted;
    render(<IdeaCells counts={counts} />);
    const cells = screen.getAllByTestId('idea-cell');
    expect(cells).toHaveLength(totalExpected);
  });

  it('renders with the expected default aria-label text', () => {
    render(<IdeaCells counts={{ underTest: 13, rejected: 1, validated: 0 }} />);
    const container = screen.getByRole('img');
    expect(container).toHaveAttribute(
      'aria-label',
      '13 ideas under test, 1 rule rejected, 0 ideas validated'
    );
  });

  it('accepts a custom label for aria-label', () => {
    render(<IdeaCells counts={counts} label="Custom Idea Summary" />);
    const container = screen.getByRole('img');
    expect(container).toHaveAttribute('aria-label', 'Custom Idea Summary');
  });

  it('rejected cells get the rejected marker', () => {
    render(<IdeaCells counts={{ underTest: 2, rejected: 1, validated: 1 }} />);
    const rejectedCells = screen
      .getAllByTestId('idea-cell')
      .filter((cell) => cell.getAttribute('data-kind') === 'rejected');

    expect(rejectedCells).toHaveLength(1);
    expect(rejectedCells[0]).toHaveClass('idea-cell-rejected');
    expect(rejectedCells[0].querySelector('[data-testid="rejected-marker"]')).toBeInTheDocument();
  });
});
