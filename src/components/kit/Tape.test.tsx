import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tape, TAPE_MAX_TICKS } from './Tape';

describe('Tape', () => {
  const sampleBets = [
    { add: true },
    { add: false },
    { add: true },
    { add: true },
    { add: false },
  ];

  it('exports TAPE_MAX_TICKS = 160', () => {
    expect(TAPE_MAX_TICKS).toBe(160);
  });

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

  it('500 bets render exactly 160 ticks, and the last tick matches the last bet add', () => {
    const bets = Array.from({ length: 500 }, (_, i) => ({ add: i === 499 }));
    render(<Tape bets={bets} evidence={1.9} threshold={800} />);
    const ticks = screen.getAllByTestId('tape-tick');
    expect(ticks).toHaveLength(160);
    expect(ticks[ticks.length - 1]).toHaveAttribute('data-add', 'true');
    expect(ticks[0]).toHaveAttribute('data-add', 'false');
  });

  it('betCount={3} renders 3 neutral ticks of one class', () => {
    render(<Tape betCount={3} evidence={1.9} threshold={800} />);
    const ticks = screen.getAllByTestId('tape-tick');
    expect(ticks).toHaveLength(3);
    for (const tick of ticks) {
      expect(tick).not.toHaveAttribute('data-add');
      expect(tick.className).toBe(ticks[0].className);
      expect(tick).toHaveClass('tape-tick-neutral');
      expect(tick).toHaveClass('h-[6px]');
      expect(tick).toHaveClass('w-[2px]');
      expect(tick).toHaveClass('bg-muted-foreground/35');
    }
  });

  it('betCount={5000} renders 160', () => {
    render(<Tape betCount={5000} evidence={1.9} threshold={800} />);
    const ticks = screen.getAllByTestId('tape-tick');
    expect(ticks).toHaveLength(160);
  });

  it('the aria label shows the full count (5000) and evidence to one decimal', () => {
    render(<Tape betCount={5000} evidence={1.94} threshold={800} />);
    const tape = screen.getByRole('img');
    expect(tape).toHaveAttribute('aria-label', '5000 bets, evidence 1.9 of 800');
  });

  it('betCount={0} and no bets render no ticks', () => {
    const { rerender } = render(<Tape betCount={0} evidence={0} threshold={800} />);
    expect(screen.queryAllByTestId('tape-tick')).toHaveLength(0);

    rerender(<Tape evidence={0} threshold={800} />);
    expect(screen.queryAllByTestId('tape-tick')).toHaveLength(0);
  });
});

