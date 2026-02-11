import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SpotlightCard } from './SpotlightCard';

describe('SpotlightCard', () => {
  it('renders children', () => {
    render(
      <SpotlightCard>
        <p>Card content</p>
      </SpotlightCard>
    );
    expect(screen.getByText('Card content')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    render(
      <SpotlightCard className="custom-class" data-testid="card">
        <p>Content</p>
      </SpotlightCard>
    );
    expect(screen.getByTestId('card')).toHaveClass('custom-class');
  });

  it('updates CSS custom properties on mouse move', () => {
    render(
      <SpotlightCard data-testid="card">
        <p>Content</p>
      </SpotlightCard>
    );
    const card = screen.getByTestId('card');

    fireEvent.mouseMove(card, { clientX: 100, clientY: 200 });

    expect(card.style.getPropertyValue('--mouse-x')).toBeTruthy();
    expect(card.style.getPropertyValue('--mouse-y')).toBeTruthy();
  });

  it('has aria-hidden overlays', () => {
    render(
      <SpotlightCard data-testid="card">
        <p>Content</p>
      </SpotlightCard>
    );
    const card = screen.getByTestId('card');
    const hiddenOverlays = card.querySelectorAll('[aria-hidden="true"]');
    expect(hiddenOverlays.length).toBeGreaterThanOrEqual(2);
  });

  it('renders with default div tag', () => {
    render(
      <SpotlightCard data-testid="card">
        <p>Content</p>
      </SpotlightCard>
    );
    expect(screen.getByTestId('card').tagName).toBe('DIV');
  });
});
