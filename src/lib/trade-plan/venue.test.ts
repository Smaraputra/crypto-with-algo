// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { VENUE_FILTERS, decimalsOf, placeability, roundPrice, roundQty, venueFilterFor } from './venue';

describe('VENUE_FILTERS', () => {
  it('covers every signal symbol', () => {
    for (const symbol of SIGNAL_SYMBOLS) {
      expect(VENUE_FILTERS[symbol]?.symbol).toBe(symbol);
    }
  });

  it('records the BTCUSDT filters confirmed on 2026-09-19 and again on 2026-10-01', () => {
    expect(venueFilterFor('BTCUSDT')).toEqual({
      symbol: 'BTCUSDT',
      stepSize: 0.001,
      minQty: 0.001,
      minNotional: 50,
      tickSize: 0.1,
    });
  });

  it('throws for a symbol with no recorded filter', () => {
    expect(() => venueFilterFor('PEPEUSDT')).toThrow('No venue filter recorded for PEPEUSDT');
  });
});

describe('roundQty', () => {
  it('rounds down to the step, never up', () => {
    expect(roundQty(0.0129, 0.001)).toBe(0.012);
    expect(roundQty(12.99, 1)).toBe(12);
    expect(roundQty(3.1999, 0.1)).toBe(3.1);
  });

  it('keeps an exact multiple despite binary floating point', () => {
    expect(roundQty(0.3, 0.1)).toBe(0.3);
    expect(roundQty(0.007, 0.001)).toBe(0.007);
  });

  it('returns 0 for a size below one step or a non-positive size', () => {
    expect(roundQty(0.0009, 0.001)).toBe(0);
    expect(roundQty(0, 0.001)).toBe(0);
    expect(roundQty(-1, 0.001)).toBe(0);
    expect(roundQty(Number.NaN, 0.001)).toBe(0);
  });
});

describe('roundPrice', () => {
  it('rounds to the nearest tick without binary noise', () => {
    expect(roundPrice(81234.567, 0.1)).toBe(81234.6);
    expect(roundPrice(0.123456, 0.00001)).toBe(0.12346);
    expect(roundPrice(2.34567, 0.0001)).toBe(2.3457);
  });
});

describe('placeability', () => {
  const btc = venueFilterFor('BTCUSDT');
  const doge = venueFilterFor('DOGEUSDT');

  it('accepts an order at or above both minimums', () => {
    expect(placeability(0.001, 81000, btc)).toBeNull();
    expect(placeability(25, 0.2, doge)).toBeNull();
  });

  it('rejects a size below the minimum quantity with the reason', () => {
    expect(placeability(0, 81000, btc)).toBe('Size 0 is below the BTCUSDT minimum of 0.001');
  });

  it('rejects a notional below the minimum with the reason', () => {
    // 0.001 BTC at 40,000 is 40 USDT, below the 50 USDT BTCUSDT minimum.
    expect(placeability(0.001, 40000, btc)).toBe(
      'Notional 40.00 USDT is below the BTCUSDT minimum of 50 USDT'
    );
    expect(placeability(20, 0.2, doge)).toBe('Notional 4.00 USDT is below the DOGEUSDT minimum of 5 USDT');
  });
});

describe('decimalsOf', () => {
  it('counts the decimal places of an increment, including exponent notation', () => {
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(0.1)).toBe(1);
    expect(decimalsOf(0.001)).toBe(3);
    expect(decimalsOf(0.00001)).toBe(5);
    expect(decimalsOf(1e-7)).toBe(7);
  });
});
