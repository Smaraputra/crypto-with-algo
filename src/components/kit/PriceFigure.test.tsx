import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PriceFigure } from './PriceFigure';

describe('PriceFigure', () => {
  it('renders the value text correctly', () => {
    render(<PriceFigure value="$67,420.50" size="hero" />);
    expect(screen.getByTestId('price-value')).toHaveTextContent('$67,420.50');
  });

  it('the up change uses text-up and the down change text-down', () => {
    const { rerender } = render(
      <PriceFigure
        value="$67,420.50"
        change={{ value: '+2.14%', direction: 'up' }}
        changeLabel="today"
      />
    );

    const upChange = screen.getByTestId('price-change');
    expect(upChange).toHaveClass('text-up');
    expect(upChange).not.toHaveClass('text-down');
    expect(upChange).toHaveTextContent('+2.14% today');

    rerender(
      <PriceFigure
        value="$67,420.50"
        change={{ value: '-1.50%', direction: 'down' }}
        changeLabel="today"
      />
    );

    const downChange = screen.getByTestId('price-change');
    expect(downChange).toHaveClass('text-down');
    expect(downChange).not.toHaveClass('text-up');
    expect(downChange).toHaveTextContent('-1.50% today');
  });

  it('size classes differ between hero, large, and medium', () => {
    const { rerender } = render(<PriceFigure value="100" size="hero" />);
    const heroEl = screen.getByTestId('price-value');
    expect(heroEl).toHaveClass('sm:text-[64px]');

    rerender(<PriceFigure value="100" size="large" />);
    const largeEl = screen.getByTestId('price-value');
    expect(largeEl).toHaveClass('text-[56px]');
    expect(largeEl).not.toHaveClass('sm:text-[64px]');

    rerender(<PriceFigure value="100" size="medium" />);
    const mediumEl = screen.getByTestId('price-value');
    expect(mediumEl).toHaveClass('text-[32px]');
    expect(mediumEl).not.toHaveClass('text-[56px]');
  });
});
