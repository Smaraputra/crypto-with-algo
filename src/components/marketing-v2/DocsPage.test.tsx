import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DocsPage } from './DocsPage';

describe('DocsPage', () => {
  it('renders exact h1 Documentation and required h2 sections', () => {
    render(<DocsPage />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Documentation' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Getting started' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Feature reference' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Data and limits' })
    ).toBeInTheDocument();
  });

  it('covers Binance public data, regional blocks, and 24h figures', () => {
    render(<DocsPage />);

    expect(screen.getByText(/Binance public data/i)).toBeInTheDocument();
    expect(screen.getByText(/24h figures/i)).toBeInTheDocument();
    expect(screen.getByText(/Regional blocks/i)).toBeInTheDocument();
  });

  it('does not contain banned marketing claims', () => {
    const { container } = render(<DocsPage />);
    expect(container.textContent).not.toMatch(
      /guarantee|profit|beat the market|predict|accuracy|win rate|tax/i
    );
    expect(container.textContent).not.toMatch(
      /public record|public research lab|public ledger|markdown|survivorship|instant|currently validated|volume delta|frozen/i
    );
  });
});
