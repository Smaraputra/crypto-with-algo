import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('@/lib/gsap', async () => await import('@/__mocks__/gsap'));
vi.mock('@gsap/react', async () => await import('@/__mocks__/@gsap/react'));

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
