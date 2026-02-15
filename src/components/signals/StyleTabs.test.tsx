import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { StyleTabs, STYLE_LABELS } from './StyleTabs';

describe('StyleTabs', () => {
  it('renders all four trading style tabs', () => {
    render(<StyleTabs value="day_trading" onValueChange={vi.fn()} />);

    expect(screen.getByText('Scalping')).toBeInTheDocument();
    expect(screen.getByText('Day Trading')).toBeInTheDocument();
    expect(screen.getByText('Swing')).toBeInTheDocument();
    expect(screen.getByText('Position')).toBeInTheDocument();
  });

  it('has test ids for each tab', () => {
    render(<StyleTabs value="scalping" onValueChange={vi.fn()} />);

    expect(screen.getByTestId('style-tab-scalping')).toBeInTheDocument();
    expect(screen.getByTestId('style-tab-day_trading')).toBeInTheDocument();
    expect(screen.getByTestId('style-tab-swing_trading')).toBeInTheDocument();
    expect(screen.getByTestId('style-tab-position_trading')).toBeInTheDocument();
  });

  it('marks the active tab', () => {
    render(<StyleTabs value="swing_trading" onValueChange={vi.fn()} />);

    const swingTab = screen.getByTestId('style-tab-swing_trading');
    expect(swingTab).toHaveAttribute('data-state', 'active');

    const scalpingTab = screen.getByTestId('style-tab-scalping');
    expect(scalpingTab).toHaveAttribute('data-state', 'inactive');
  });

  it('exports STYLE_LABELS', () => {
    expect(STYLE_LABELS.scalping).toBe('Scalping');
    expect(STYLE_LABELS.day_trading).toBe('Day Trading');
    expect(STYLE_LABELS.swing_trading).toBe('Swing');
    expect(STYLE_LABELS.position_trading).toBe('Position');
  });

  // Note: Radix Tabs onValueChange doesn't fire via fireEvent.click in jsdom.
  // Tab click interaction is tested via E2E. Here we verify the tab structure.
  it('renders as interactive tab triggers', () => {
    render(<StyleTabs value="day_trading" onValueChange={vi.fn()} />);

    const scalpingTab = screen.getByTestId('style-tab-scalping');
    expect(scalpingTab).toHaveAttribute('role', 'tab');
    expect(scalpingTab).toHaveAttribute('data-state', 'inactive');
  });
});
