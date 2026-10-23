import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PriceScoreRecord } from './PriceScoreRecord';
import { V8_STATUS } from '@/lib/signals/v8-status';

describe('PriceScoreRecord', () => {
  it('renders "Price score", "No edge (measured)", description and all study names in details', () => {
    render(<PriceScoreRecord />);

    expect(screen.getByRole('heading', { name: 'Price score' })).toBeInTheDocument();
    expect(screen.getByText('No edge (measured)')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Measured on years of history and found no edge after costs. Shown elsewhere as context only.'
      )
    ).toBeInTheDocument();

    expect(screen.getByText('What was measured')).toBeInTheDocument();

    for (const study of V8_STATUS.studies) {
      expect(screen.getByText(study.name)).toBeInTheDocument();
      expect(screen.getByText(study.verdict)).toBeInTheDocument();
    }
  });

  it('gives the What was measured summary an aria-hidden chevron svg', () => {
    render(<PriceScoreRecord />);
    const summary = screen.getByText('What was measured').closest('summary');
    expect(summary?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
  });
});
