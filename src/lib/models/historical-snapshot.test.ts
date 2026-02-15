import { describe, it, expect } from 'vitest';
import { HistoricalSnapshot } from './historical-snapshot';

function makeValidData(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    timestamp: 1700000000000,
    interval: '1h',
    ...overrides,
  };
}

describe('HistoricalSnapshot model', () => {
  it('validates a document with required fields only', () => {
    const doc = new HistoricalSnapshot(makeValidData());
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('sets data to empty object by default', () => {
    const doc = new HistoricalSnapshot(makeValidData());
    expect(doc.data).toBeDefined();
  });

  it('accepts fundingRate data', () => {
    const doc = new HistoricalSnapshot(
      makeValidData({
        data: {
          fundingRate: { rate: 0.0001, markPrice: 50000 },
        },
      })
    );
    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.data.fundingRate?.rate).toBe(0.0001);
    expect(doc.data.fundingRate?.markPrice).toBe(50000);
  });

  it('accepts longShortRatio data', () => {
    const doc = new HistoricalSnapshot(
      makeValidData({
        data: {
          longShortRatio: { ratio: 1.5, longAccount: 60, shortAccount: 40 },
        },
      })
    );
    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.data.longShortRatio?.ratio).toBe(1.5);
    expect(doc.data.longShortRatio?.longAccount).toBe(60);
    expect(doc.data.longShortRatio?.shortAccount).toBe(40);
  });

  it('accepts openInterest data', () => {
    const doc = new HistoricalSnapshot(
      makeValidData({
        data: {
          openInterest: { value: 100000, sumValue: 5000000000 },
        },
      })
    );
    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.data.openInterest?.value).toBe(100000);
    expect(doc.data.openInterest?.sumValue).toBe(5000000000);
  });

  it('accepts newsSentiment data', () => {
    const doc = new HistoricalSnapshot(
      makeValidData({
        data: {
          newsSentiment: {
            count: 15,
            avgSentiment: 0.3,
            topics: ['bitcoin', 'halving'],
          },
        },
      })
    );
    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.data.newsSentiment?.count).toBe(15);
    expect(doc.data.newsSentiment?.avgSentiment).toBe(0.3);
    expect(doc.data.newsSentiment?.topics).toEqual(['bitcoin', 'halving']);
  });

  it('accepts fearGreed data', () => {
    const doc = new HistoricalSnapshot(
      makeValidData({
        data: {
          fearGreed: { index: 72, label: 'Greed' },
        },
      })
    );
    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.data.fearGreed?.index).toBe(72);
    expect(doc.data.fearGreed?.label).toBe('Greed');
  });

  it('accepts all data sub-objects together', () => {
    const doc = new HistoricalSnapshot(
      makeValidData({
        data: {
          fundingRate: { rate: 0.0001, markPrice: 50000 },
          longShortRatio: { ratio: 1.5, longAccount: 60, shortAccount: 40 },
          openInterest: { value: 100000, sumValue: 5000000000 },
          newsSentiment: { count: 10, avgSentiment: 0.2, topics: ['btc'] },
          fearGreed: { index: 50, label: 'Neutral' },
        },
      })
    );
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('rejects missing symbol', () => {
    const doc = new HistoricalSnapshot(makeValidData({ symbol: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('symbol');
  });

  it('rejects missing timestamp', () => {
    const doc = new HistoricalSnapshot(makeValidData({ timestamp: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('timestamp');
  });

  it('rejects missing interval', () => {
    const doc = new HistoricalSnapshot(makeValidData({ interval: undefined }));
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err!.errors).toHaveProperty('interval');
  });

  it('stores numeric fields correctly', () => {
    const doc = new HistoricalSnapshot(makeValidData());
    expect(doc.symbol).toBe('BTCUSDT');
    expect(doc.timestamp).toBe(1700000000000);
    expect(doc.interval).toBe('1h');
  });

  it('generates an _id automatically', () => {
    const doc = new HistoricalSnapshot(makeValidData());
    expect(doc._id).toBeDefined();
  });
});
