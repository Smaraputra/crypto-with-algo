import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CursorGlow } from './CursorGlow';

describe('CursorGlow', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches:
          query === '(hover: hover)'
            ? true
            : false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  it('renders a fixed glow element', () => {
    render(<CursorGlow />);
    const glow = screen.getByTestId('cursor-glow');
    expect(glow).toBeInTheDocument();
    expect(glow).toHaveAttribute('aria-hidden', 'true');
  });

  it('has pointer-events-none class', () => {
    render(<CursorGlow />);
    const glow = screen.getByTestId('cursor-glow');
    expect(glow).toHaveClass('pointer-events-none');
  });

  it('starts with opacity 0', () => {
    render(<CursorGlow />);
    const glow = screen.getByTestId('cursor-glow');
    expect(glow.style.opacity).toBe('0');
  });

  it('becomes visible on pointer move', () => {
    render(<CursorGlow />);
    fireEvent.pointerMove(document, { clientX: 200, clientY: 300 });
    const glow = screen.getByTestId('cursor-glow');
    expect(glow.style.opacity).toBe('1');
  });
});
