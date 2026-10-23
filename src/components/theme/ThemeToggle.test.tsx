import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ThemeToggle } from './ThemeToggle';
import { THEME_STORAGE_KEY } from '@/lib/theme';

describe('ThemeToggle', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.style.colorScheme = '';
  });

  afterEach(() => {
    cleanup();
    document.documentElement.className = '';
    localStorage.clear();
  });

  it('renders a switch named "Dark"', () => {
    render(<ThemeToggle />);
    const toggle = screen.getByRole('switch', { name: /dark/i });
    expect(toggle).toBeInTheDocument();
  });

  it('is checked when documentElement has dark', () => {
    document.documentElement.classList.add('dark');
    render(<ThemeToggle />);
    const toggle = screen.getByRole('switch', { name: /dark/i });
    expect(toggle).toBeChecked();
  });

  it('is unchecked when documentElement lacks dark', () => {
    document.documentElement.classList.remove('dark');
    render(<ThemeToggle />);
    const toggle = screen.getByRole('switch', { name: /dark/i });
    expect(toggle).not.toBeChecked();
  });

  it('clicking it removes dark and stores light, then clicking again restores dark', () => {
    document.documentElement.classList.add('dark');
    render(<ThemeToggle />);
    const toggle = screen.getByRole('switch', { name: /dark/i });
    expect(toggle).toBeChecked();

    // Click to toggle to light
    fireEvent.click(toggle);

    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    // Click again to toggle back to dark
    fireEvent.click(toggle);

    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('uses ink fill bg-foreground on track and bg-background on knob when dark', () => {
    document.documentElement.classList.add('dark');
    const { container } = render(<ThemeToggle />);
    const track = container.querySelector('span[aria-hidden="true"]');
    expect(track).toHaveClass('bg-foreground');
    expect(track).not.toHaveClass('bg-brand');

    const knob = track?.firstElementChild;
    expect(knob).toHaveClass('bg-background');
    expect(knob).not.toHaveClass('bg-brand-foreground');
  });
});
