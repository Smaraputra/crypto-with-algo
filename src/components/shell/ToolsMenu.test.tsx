import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolsMenu } from './ToolsMenu';

const mockUsePathname = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}));

describe('ToolsMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePathname.mockReturnValue('/dashboard');
  });

  it('renders Tools trigger button with idle state on non-tools paths', () => {
    mockUsePathname.mockReturnValue('/dashboard');
    render(<ToolsMenu />);
    const trigger = screen.getByRole('button', { name: /tools/i });
    expect(trigger).toBeInTheDocument();
    expect(trigger).not.toHaveAttribute('aria-current');
    expect(trigger).not.toHaveAttribute('data-active');
  });

  it('on /cost-check the trigger has data-active and no aria-current', () => {
    mockUsePathname.mockReturnValue('/cost-check');
    const { rerender } = render(<ToolsMenu />);
    const trigger = screen.getByRole('button', { name: /tools/i });
    expect(trigger).toHaveAttribute('data-active');
    expect(trigger).not.toHaveAttribute('aria-current');

    mockUsePathname.mockReturnValue('/backtest');
    rerender(<ToolsMenu />);
    expect(trigger).toHaveAttribute('data-active');
    expect(trigger).not.toHaveAttribute('aria-current');
  });

  it('opening it shows Cost Check and Backtest with the right hrefs, and no Notes or Analytics item', () => {
    render(<ToolsMenu />);
    const trigger = screen.getByRole('button', { name: /tools/i });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);

    const costCheck = screen.getByRole('menuitem', { name: 'Cost Check' });
    expect(costCheck).toBeInTheDocument();
    expect(costCheck).toHaveAttribute('href', '/cost-check');

    const backtest = screen.getByRole('menuitem', { name: 'Backtest' });
    expect(backtest).toBeInTheDocument();
    expect(backtest).toHaveAttribute('href', '/backtest');

    expect(screen.queryByRole('menuitem', { name: 'Signals' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Notes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Analytics' })).not.toBeInTheDocument();
  });

  it('menu item link for current page has aria-current="page"', () => {
    mockUsePathname.mockReturnValue('/cost-check');
    render(<ToolsMenu />);
    const trigger = screen.getByRole('button', { name: /tools/i });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.click(trigger);

    const costCheck = screen.getByRole('menuitem', { name: 'Cost Check' });
    expect(costCheck).toHaveAttribute('aria-current', 'page');

    const backtest = screen.getByRole('menuitem', { name: 'Backtest' });
    expect(backtest).not.toHaveAttribute('aria-current');
  });
});
