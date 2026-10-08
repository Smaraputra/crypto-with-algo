import { describe, expect, it } from 'vitest';

import { parseVenueFilters, type ExchangeInfoSymbolFilters } from './venue-filters';

const base: ExchangeInfoSymbolFilters = {
  symbol: 'BTCUSDT',
  status: 'TRADING',
  contractType: 'PERPETUAL',
  filters: [
    { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '1000' },
    { filterType: 'MIN_NOTIONAL', notional: '50' },
    { filterType: 'PRICE_FILTER', tickSize: '0.10' },
  ],
};

describe('parseVenueFilters', () => {
  it('reads lot, notional and tick filters', () => {
    expect(parseVenueFilters([base]).get('BTCUSDT')).toEqual({
      symbol: 'BTCUSDT',
      status: 'TRADING',
      stepSize: 0.001,
      minQty: 0.001,
      minNotional: 50,
      tickSize: 0.1,
    });
  });

  it('adds MARKET_LOT_SIZE when present', () => {
    const f = parseVenueFilters([
      { ...base, filters: [...base.filters, { filterType: 'MARKET_LOT_SIZE', stepSize: '0.01', minQty: '0.02' }] },
    ]).get('BTCUSDT');
    expect(f?.marketStepSize).toBe(0.01);
    expect(f?.marketMinQty).toBe(0.02);
  });

  it('skips non-perpetuals and symbols missing a required filter', () => {
    const out = parseVenueFilters([
      { ...base, symbol: 'Q', contractType: 'CURRENT_QUARTER' },
      { ...base, symbol: 'NOLOT', filters: base.filters.slice(1) },
    ]);
    expect(out.size).toBe(0);
  });
});
