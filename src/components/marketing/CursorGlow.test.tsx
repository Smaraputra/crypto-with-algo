import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CursorGlow } from './CursorGlow';

describe('CursorGlow', () => {
  let originalMaxTouchPoints: number;

  beforeEach(() => {
    // Save original maxTouchPoints
    originalMaxTouchPoints = navigator.maxTouchPoints;

    // Ensure we're not on a touch device by default
    Object.defineProperty(navigator, 'maxTouchPoints', {
      writable: true,
      configurable: true,
      value: 0,
    });

    // Ensure ontouchstart is not present
    if ('ontouchstart' in window) {
      delete (window as unknown as Record<string, unknown>).ontouchstart;
    }

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

  afterEach(() => {
    // Restore original maxTouchPoints
    Object.defineProperty(navigator, 'maxTouchPoints', {
      writable: true,
      configurable: true,
      value: originalMaxTouchPoints,
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

  it('becomes visible on pointer move on non-touch devices', () => {
    render(<CursorGlow />);
    fireEvent.pointerMove(document, { clientX: 200, clientY: 300 });
    const glow = screen.getByTestId('cursor-glow');
    expect(glow.style.opacity).toBe('1');
  });

  it('does not activate on touch devices', () => {
    // Simulate touch device
    Object.defineProperty(navigator, 'maxTouchPoints', {
      writable: true,
      configurable: true,
      value: 5,
    });

    render(<CursorGlow />);
    fireEvent.pointerMove(document, { clientX: 200, clientY: 300 });
    const glow = screen.getByTestId('cursor-glow');
    // On touch devices, the effect should not activate
    expect(glow.style.opacity).toBe('0');
  });
});
