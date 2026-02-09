import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { LandingButton } from './LandingButton';

describe('LandingButton', () => {
  it('renders as a link with children', () => {
    render(<LandingButton href="/test">Click me</LandingButton>);
    const link = screen.getByRole('link', { name: 'Click me' });
    expect(link).toHaveAttribute('href', '/test');
  });

  it('renders outline variant with fill sweep element', () => {
    render(<LandingButton variant="outline" href="#">Outline</LandingButton>);
    const link = screen.getByRole('link');
    expect(link.className).toContain('border');
    expect(link.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('renders solid variant with accent background', () => {
    render(<LandingButton variant="solid" href="#">Solid</LandingButton>);
    const link = screen.getByRole('link');
    expect(link.className).toContain('bg-accent');
    expect(link.querySelector('[aria-hidden="true"]')).not.toBeInTheDocument();
  });

  it('applies lg size class', () => {
    render(<LandingButton size="lg" href="#">Large</LandingButton>);
    const link = screen.getByRole('link');
    expect(link.className).toContain('h-12');
  });
});
