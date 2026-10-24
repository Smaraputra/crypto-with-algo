import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FeaturesPage } from './FeaturesPage';

describe('FeaturesPage', () => {
  it('renders exact h1 Features and required h2 groups', () => {
    render(<FeaturesPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Features' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Market and coins' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Research' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Your trades' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Tools' })).toBeInTheDocument();
  });

  it('explicitly states that the price score is context only with no measured edge', () => {
    render(<FeaturesPage />);

    expect(
      screen.getByText('Context only, measured on years of history with no edge after costs.')
    ).toBeInTheDocument();
  });

  it('does not contain banned marketing claims', () => {
    const { container } = render(<FeaturesPage />);
    expect(container.textContent).not.toMatch(
      /guarantee|profit|beat the market|predict|accuracy|win rate|tax/i
    );
    expect(container.textContent).not.toMatch(
      /public record|public research lab|public ledger|markdown|survivorship|instant|currently validated|volume delta|frozen/i
    );
  });
});
