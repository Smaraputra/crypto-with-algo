import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tape } from './Tape';

describe('Tape', () => {
  const sampleBets = [
    { add: true },
    { add: false },
    { add: true },
    { add: true },
    { add: false },
  ];

  it('evidence 1.9 of threshold 800 gives a fill width style of 0.2375%', () => {
    render(<Tape bets={sampleBets} evidence={1.9} threshold={800} />);
    const fill = screen.getByTestId('tape-fill');
    expect(fill).toHaveStyle({ width: '0.2375%' });
  });

  it('evidence above the threshold caps at 100%', () => {
    render(<Tape bets={sampleBets} evidence={950} threshold={800} />);
    const fill = screen.getByTestId('tape-fill');
    expect(fill).toHaveStyle({ width: '100%' });
  });

  it('the aria-label text is correct', () => {
    const bets = Array.from({ length: 14 }, (_, i) => ({ add: i % 2 === 0 }));
    render(<Tape bets={bets} evidence={1.9} threshold={800} />);
    const tape = screen.getByRole('img');
    expect(tape).toHaveAttribute('aria-label', '14 bets, evidence 1.9 of 800');
  });

  it('accepts a custom label for aria-label', () => {
    render(<Tape bets={sampleBets} evidence={1.9} threshold={800} label="Custom Tape Summary" />);
    const tape = screen.getByRole('img');
    expect(tape).toHaveAttribute('aria-label', 'Custom Tape Summary');
  });

  it('the tick count equals bets.length', () => {
    render(<Tape bets={sampleBets} evidence={1.9} threshold={800} />);
    const ticks = screen.getAllByTestId('tape-tick');
    expect(ticks).toHaveLength(sampleBets.length);
  });

  it('add ticks and not-add ticks get different classes', () => {
    render(<Tape bets={sampleBets} evidence={1.9} threshold={800} />);
    const ticks = screen.getAllByTestId('tape-tick');
    const addTick = ticks.find((tick) => tick.getAttribute('data-add') === 'true');
    const notAddTick = ticks.find((tick) => tick.getAttribute('data-add') === 'false');

    expect(addTick).toBeDefined();
    expect(notAddTick).toBeDefined();
    expect(addTick?.className).not.toEqual(notAddTick?.className);
    expect(addTick?.className).toContain('bg-foreground');
    expect(notAddTick?.className).toContain('bg-muted-foreground');
  });
});
