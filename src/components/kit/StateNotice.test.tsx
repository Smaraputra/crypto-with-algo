import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StateNotice } from './StateNotice';

describe('StateNotice', () => {
  it('the loading kind has role status with aria-busy', () => {
    render(
      <StateNotice
        kind="loading"
        title="Loading prices from Binance."
      />
    );
    const notice = screen.getByRole('status');
    expect(notice).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading prices from Binance.')).toBeInTheDocument();
    expect(screen.getByTestId('skeleton-rows')).toBeInTheDocument();
  });

  it('the error kind has role alert', () => {
    render(
      <StateNotice
        kind="error"
        title="Prices did not load."
        description="Binance did not answer. Your watchlist is unchanged."
        action={<button type="button">Try again</button>}
      />
    );
    const notice = screen.getByRole('alert');
    expect(notice).toBeInTheDocument();
    expect(screen.getByText('Prices did not load.')).toBeInTheDocument();
    expect(
      screen.getByText('Binance did not answer. Your watchlist is unchanged.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('empty renders the action', () => {
    render(
      <StateNotice
        kind="empty"
        title="No alerts yet."
        description="You have not set a price condition."
        action={<button type="button">Create an alert</button>}
      />
    );
    expect(screen.getByText('No alerts yet.')).toBeInTheDocument();
    expect(screen.getByText('You have not set a price condition.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create an alert' })).toBeInTheDocument();
  });
});
