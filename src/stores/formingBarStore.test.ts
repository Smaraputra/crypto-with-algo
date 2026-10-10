import { beforeEach, describe, expect, it } from 'vitest';
import { useFormingBarStore, type FormingBarEvent } from './formingBarStore';

const EVENT: FormingBarEvent = {
  symbol: 'BTCUSDT',
  interval: '1h',
  bar: { openTime: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, takerBuyVolume: 4 },
  closed: false,
  receivedAt: 123,
};

describe('formingBarStore', () => {
  beforeEach(() => useFormingBarStore.getState().reset());

  it('starts empty, holds the latest event and resets', () => {
    expect(useFormingBarStore.getState().latest).toBeNull();
    useFormingBarStore.getState().push(EVENT);
    expect(useFormingBarStore.getState().latest).toEqual(EVENT);
    useFormingBarStore.getState().reset();
    expect(useFormingBarStore.getState().latest).toBeNull();
  });

  it('carries market data only, never a score', () => {
    useFormingBarStore.getState().push(EVENT);
    const json = JSON.stringify(useFormingBarStore.getState());
    for (const key of ['score', 'tier', 'confidence', 'components']) {
      expect(json).not.toContain(`"${key}"`);
    }
  });
});
