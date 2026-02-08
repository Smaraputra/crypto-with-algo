import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { PriceCard } from './PriceCard';
import type { Ticker24h } from '@/types/market';

function makeTicker(overrides: Partial<Ticker24h> = {}): Ticker24h {
  return {
    symbol: 'BTCUSDT',
    lastPrice: '40500.00',
    priceChange: '500.00',
    priceChangePercent: '1.25',
    highPrice: '41000.00',
    lowPrice: '39500.00',
    volume: '1000.50',
    quoteVolume: '40500000.00',
    openPrice: '40000.00',
    count: 50000,
    ...overrides,
  };
}

describe('PriceCard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders symbol as BASE/USDT', () => {
    render(<PriceCard ticker={makeTicker({ symbol: 'ETHUSDT' })} />);
    expect(screen.getByText('ETH/USDT')).toBeInTheDocument();
  });

  it('renders formatted price with commas', () => {
    render(<PriceCard ticker={makeTicker({ lastPrice: '40500.00' })} />);
    expect(screen.getByText('$40,500')).toBeInTheDocument();
  });

  it('renders percentage with + prefix for positive change', () => {
    render(<PriceCard ticker={makeTicker({ priceChangePercent: '1.25' })} />);
    expect(screen.getByText('+1.25%')).toBeInTheDocument();
  });

  it('renders percentage without + prefix for negative change', () => {
    render(<PriceCard ticker={makeTicker({ priceChangePercent: '-2.50' })} />);
    expect(screen.getByText('-2.50%')).toBeInTheDocument();
  });

  it('applies text-bullish for positive change', () => {
    render(<PriceCard ticker={makeTicker({ priceChangePercent: '1.25' })} />);
    const pctEl = screen.getByText('+1.25%');
    expect(pctEl.className).toContain('text-bullish');
  });

  it('applies text-bearish for negative change', () => {
    render(<PriceCard ticker={makeTicker({ priceChangePercent: '-2.50' })} />);
    const pctEl = screen.getByText('-2.50%');
    expect(pctEl.className).toContain('text-bearish');
  });

  it('shows live indicator dot when isLive is true', () => {
    const { container } = render(<PriceCard ticker={makeTicker()} isLive />);
    const dot = container.querySelector('.bg-bullish.animate-pulse');
    expect(dot).toBeInTheDocument();
  });

  it('hides live indicator dot when isLive is false', () => {
    const { container } = render(<PriceCard ticker={makeTicker()} isLive={false} />);
    const dot = container.querySelector('.bg-bullish.animate-pulse');
    expect(dot).not.toBeInTheDocument();
  });

  it('applies selected border styles', () => {
    const { container } = render(<PriceCard ticker={makeTicker()} selected />);
    const button = container.querySelector('button')!;
    expect(button.className).toContain('border-primary/40');
    expect(button.className).toContain('bg-card-hover');
  });

  it('calls onClick handler', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const handleClick = vi.fn();
    render(<PriceCard ticker={makeTicker()} onClick={handleClick} />);
    await user.click(screen.getByRole('button'));
    expect(handleClick).toHaveBeenCalledOnce();
  });

  it('applies flash-up animation on price increase then clears after 400ms', () => {
    const ticker = makeTicker({ lastPrice: '40500.00' });
    const { container, rerender } = render(<PriceCard ticker={ticker} />);
    const button = container.querySelector('button')!;

    expect(button.className).not.toContain('animate-flash-up');

    // Rerender with higher price
    const updatedTicker = makeTicker({ lastPrice: '41000.00' });
    rerender(<PriceCard ticker={updatedTicker} />);

    expect(button.className).toContain('animate-flash-up');

    // Flash clears after 400ms
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(button.className).not.toContain('animate-flash-up');
  });

  it('applies flash-down animation on price decrease', () => {
    const ticker = makeTicker({ lastPrice: '40500.00' });
    const { container, rerender } = render(<PriceCard ticker={ticker} />);
    const button = container.querySelector('button')!;

    const updatedTicker = makeTicker({ lastPrice: '39000.00' });
    rerender(<PriceCard ticker={updatedTicker} />);

    expect(button.className).toContain('animate-flash-down');
  });
});
