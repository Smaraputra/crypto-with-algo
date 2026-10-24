import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EvidenceTape,
  ILLUSTRATIVE_BETS,
  calculateEvidence,
  TAPE_THRESHOLD,
} from './EvidenceTape';

describe('EvidenceTape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it('renders caption, copy, threshold and calculated evidence', () => {
    render(<EvidenceTape />);

    expect(screen.getByText('Illustration, not live data.')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'How evidence builds' })
    ).toBeInTheDocument();

    const expectedEvidence = calculateEvidence(ILLUSTRATIVE_BETS);
    expect(expectedEvidence).toBeLessThan(TAPE_THRESHOLD);
    expect(
      screen.getByText(new RegExp(`${expectedEvidence.toFixed(1)}`))
    ).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Open the lab' })).toHaveAttribute(
      'href',
      '/lab'
    );
  });

  it('under reduced motion no element has an animation class', () => {
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    const { container } = render(<EvidenceTape />);

    const animatedElements = container.querySelectorAll(
      '[class*="animate"], [class*="tape-reveal"]'
    );
    expect(animatedElements).toHaveLength(0);
  });

  it('does not contain banned marketing claims', () => {
    const { container } = render(<EvidenceTape />);
    expect(container.textContent).not.toMatch(
      /guarantee|profit|beat the market|predict|accuracy|win rate|instant|public record|frozen|currently validated/i
    );
  });
});
