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
  });

  it('has aria-current="page" on /cost-check and /backtest', () => {
    mockUsePathname.mockReturnValue('/cost-check');
    const { rerender } = render(<ToolsMenu />);
    expect(screen.getByRole('button', { name: /tools/i })).toHaveAttribute('aria-current', 'page');

    mockUsePathname.mockReturnValue('/backtest');
    rerender(<ToolsMenu />);
    expect(screen.getByRole('button', { name: /tools/i })).toHaveAttribute('aria-current', 'page');
  });

  it('opening it shows Cost Check and Backtest with the right hrefs, then the interim Signals, Notes (/research) and Analytics items', () => {
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

    const signals = screen.getByRole('menuitem', { name: 'Signals' });
    expect(signals).toBeInTheDocument();
    expect(signals).toHaveAttribute('href', '/signals');

    const notes = screen.getByRole('menuitem', { name: 'Notes' });
    expect(notes).toBeInTheDocument();
    expect(notes).toHaveAttribute('href', '/research');

    const analytics = screen.getByRole('menuitem', { name: 'Analytics' });
    expect(analytics).toBeInTheDocument();
    expect(analytics).toHaveAttribute('href', '/analytics');
  });
});
