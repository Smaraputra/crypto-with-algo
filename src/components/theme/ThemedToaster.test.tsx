import { render, screen, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemedToaster } from './ThemedToaster';
import { applyTheme } from '@/lib/theme';

vi.mock('sonner', () => ({
  Toaster: (p: { theme?: string }) => <div data-testid="toaster" data-theme={p.theme} />,
}));

describe('ThemedToaster', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });

  afterEach(() => {
    cleanup();
    document.documentElement.className = '';
    localStorage.clear();
  });

  it('sets data-theme="dark" when documentElement has dark class', () => {
    document.documentElement.classList.add('dark');
    render(<ThemedToaster />);
    const toaster = screen.getByTestId('toaster');
    expect(toaster).toHaveAttribute('data-theme', 'dark');
  });

  it('sets data-theme="light" when documentElement lacks dark class', () => {
    document.documentElement.classList.remove('dark');
    render(<ThemedToaster />);
    const toaster = screen.getByTestId('toaster');
    expect(toaster).toHaveAttribute('data-theme', 'light');
  });

  it('updates data-theme when documentElement theme class changes', () => {
    document.documentElement.classList.add('dark');
    render(<ThemedToaster />);
    const toaster = screen.getByTestId('toaster');
    expect(toaster).toHaveAttribute('data-theme', 'dark');

    act(() => {
      applyTheme('light');
    });

    expect(toaster).toHaveAttribute('data-theme', 'light');

    act(() => {
      applyTheme('dark');
    });

    expect(toaster).toHaveAttribute('data-theme', 'dark');
  });
});
