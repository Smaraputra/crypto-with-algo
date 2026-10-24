import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import NotFound, { metadata } from './not-found';

describe('NotFound', () => {
  it('has the expected metadata title', () => {
    expect(metadata.title).toBe('Page not found | CryptoWithAlgo');
  });

  it('renders the h1 heading', () => {
    render(<NotFound />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Page not found' })
    ).toBeInTheDocument();
  });

  it('renders both links: Go to the home page and Open the app', () => {
    render(<NotFound />);

    const homeLink = screen.getByRole('link', { name: 'Go to the home page' });
    expect(homeLink).toBeInTheDocument();
    expect(homeLink).toHaveAttribute('href', '/');

    const appLink = screen.getByRole('link', { name: 'Open the app' });
    expect(appLink).toBeInTheDocument();
    expect(appLink).toHaveAttribute('href', '/dashboard');
  });

  it('renders the product name linking to /', () => {
    render(<NotFound />);

    const brandLink = screen.getByRole('link', { name: /CryptoWithAlgo/ });
    expect(brandLink).toBeInTheDocument();
    expect(brandLink).toHaveAttribute('href', '/');
  });

  it('renders the description message', () => {
    render(<NotFound />);

    expect(
      screen.getByText('The address may be mistyped, or the page has moved.')
    ).toBeInTheDocument();
  });
});
