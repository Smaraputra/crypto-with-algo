import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import { HeroBackground } from './HeroBackground';

describe('HeroBackground', () => {
  it('renders with aria-hidden', () => {
    const { container } = render(<HeroBackground />);
    const bg = container.firstElementChild;
    expect(bg).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders gradient orbs', () => {
    const { container } = render(<HeroBackground />);
    const orbs = container.querySelectorAll('[data-orb]');
    expect(orbs.length).toBeGreaterThanOrEqual(2);
  });
});
