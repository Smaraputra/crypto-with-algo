import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/gsap', async () => await import('@/__mocks__/gsap'));
vi.mock('lenis', async () => await import('@/__mocks__/lenis'));

import { SmoothScroll } from './SmoothScroll';

describe('SmoothScroll', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
    });
  });

  it('renders children', () => {
    render(
      <SmoothScroll>
        <div data-testid="child">Content</div>
      </SmoothScroll>
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });
});
