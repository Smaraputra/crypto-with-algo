import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MarketingHowItWorksPage, { metadata } from './page';

describe('MarketingHowItWorksPage', () => {
  it('exports honest metadata', () => {
    expect(metadata.title).toBe('How it works | CryptoWithAlgo');
    expect(metadata.description).toBeDefined();
  });

  it('renders exact h1 How it works and all five step h2 headings', () => {
    render(<MarketingHowItWorksPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'How it works' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /create an account/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /pick coins/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /study a coin with its costs/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /record trades and notes/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: /follow the lab's record/i })
    ).toBeInTheDocument();
  });

  it('does not contain banned marketing claims', () => {
    const { container } = render(<MarketingHowItWorksPage />);
    expect(container.textContent).not.toMatch(
      /guarantee|profit|beat the market|predict|accuracy|win rate|tax/i
    );
  });
});
