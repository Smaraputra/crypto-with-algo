import { describe, expect, it } from 'vitest';
import { barArrivalFrom } from './useBarArrivalLag';

describe('barArrivalFrom', () => {
  it('a closed kline with T = 59_999 received at now = 60_700 gives lagMs 700', () => {
    const res = barArrivalFrom({ k: { x: true, T: 59_999 } }, 60_700);
    expect(res).toEqual({
      closeTime: 59_999,
      receivedAt: 60_700,
      lagMs: 700,
    });
  });

  it('x: false gives null', () => {
    const res = barArrivalFrom({ k: { x: false, T: 59_999 } }, 60_700);
    expect(res).toBeNull();
  });

  it('a missing k, or T as a string, gives null', () => {
    expect(barArrivalFrom({}, 60_700)).toBeNull();
    expect(barArrivalFrom({ k: null }, 60_700)).toBeNull();
    expect(barArrivalFrom(null, 60_700)).toBeNull();
    expect(barArrivalFrom({ k: { x: true, T: '59999' } }, 60_700)).toBeNull();
  });

  it('a receive time before close gives lagMs 0', () => {
    const res = barArrivalFrom({ k: { x: true, T: 59_999 } }, 59_000);
    expect(res).toEqual({
      closeTime: 59_999,
      receivedAt: 59_000,
      lagMs: 0,
    });
  });
});
