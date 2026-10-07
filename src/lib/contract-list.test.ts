// @vitest-environment node
import { describe, it, expect } from 'vitest';

import { parseContractList } from './contract-list';

describe('parseContractList', () => {
  it('accepts a valid list, sorting and deduplicating dates', () => {
    expect(
      parseContractList([
        { symbol: 'BTCUSDT', klineMonths: ['2020-02', '2020-01', '2020-02'], klineDays: ['2022-02-28'], fundingMonths: ['2020-01'] },
        { symbol: 'AERGOUSDTSETTLEDSETTLED' },
        { symbol: 'AUSDT' },
      ])
    ).toEqual([
      { symbol: 'BTCUSDT', klineMonths: ['2020-01', '2020-02'], fundingMonths: ['2020-01'], klineDays: ['2022-02-28'] },
      { symbol: 'AERGOUSDTSETTLEDSETTLED' },
      { symbol: 'AUSDT' },
    ]);
  });

  it.each([
    [{}, /JSON array/],
    [[], /empty/],
    [['BTCUSDT'], /not an object/],
    [[{ symbol: '../../etc/passwdUSDT' }], /archive-contract shape/],
    [[{ symbol: 'BTCUSDC' }], /archive-contract shape/],
    [[{ symbol: 'btcusdt' }], /archive-contract shape/],
    [[{ symbol: 'BTCUSDT' }, { symbol: 'BTCUSDT' }], /twice/],
    [[{ symbol: 'BTCUSDT', klineMonths: ['2020-13'] }], /real YYYY-MM/],
    [[{ symbol: 'BTCUSDT', klineDays: ['2022-02-30'] }], /real YYYY-MM-DD/],
    [[{ symbol: 'BTCUSDT', fundingMonths: '2020-01' }], /must be an array/],
  ])('refuses %j', (input, message) => {
    expect(() => parseContractList(input)).toThrow(message);
  });
});
