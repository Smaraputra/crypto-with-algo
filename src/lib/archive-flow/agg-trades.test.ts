import { describe, expect, it } from 'vitest';
import { parseAggTradeLine } from './agg-trades';

describe('parseAggTradeLine', () => {
  it('parses a data row', () => {
    expect(parseAggTradeLine('26129,0.01633102,4.70443515,27781,27781,1498793709153,true')).toEqual(
      {
        price: 0.01633102,
        quantity: 4.70443515,
        firstTradeId: 27781,
        lastTradeId: 27781,
        transactTime: 1498793709153,
        isBuyerMaker: true,
      }
    );
  });

  it('returns null for the header row', () => {
    expect(
      parseAggTradeLine(
        'agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker'
      )
    ).toBeNull();
  });

  it('parses is_buyer_maker in both cases', () => {
    const row = (flag: string) => `1,10,1,1,1,1700000000000,${flag}`;
    expect(parseAggTradeLine(row('true'))?.isBuyerMaker).toBe(true);
    expect(parseAggTradeLine(row('false'))?.isBuyerMaker).toBe(false);
    expect(parseAggTradeLine(row('True'))?.isBuyerMaker).toBe(true);
    expect(parseAggTradeLine(row('False'))?.isBuyerMaker).toBe(false);
  });

  it('throws on a malformed row', () => {
    expect(() => parseAggTradeLine('1,10,1,1,1,1700000000000')).toThrow(/malformed/i);
    expect(() => parseAggTradeLine('1,abc,1,1,1,1700000000000,true')).toThrow(/malformed/i);
    expect(() => parseAggTradeLine('1,10,1,1,1,1700000000000,maybe')).toThrow(/malformed/i);
    expect(() => parseAggTradeLine('1,10,1,5,1,1700000000000,true')).toThrow(/malformed/i);
    expect(() => parseAggTradeLine('1,10,-1,1,1,1700000000000,true')).toThrow(/malformed/i);
  });
});

describe('parseAggTradeLine transact_time bounds', () => {
  const row = (t: string) => `1,10,1,1,1,${t},true`;

  it('accepts the bounds of the sane range', () => {
    expect(parseAggTradeLine(row(String(Date.UTC(2017, 0, 1))))?.transactTime).toBe(
      Date.UTC(2017, 0, 1)
    );
    expect(parseAggTradeLine(row(String(Date.UTC(2100, 0, 1) - 1)))).not.toBeNull();
  });

  it('throws on a microsecond epoch, a seconds epoch, and a fractional time', () => {
    expect(() => parseAggTradeLine(row('1700000000000000'))).toThrow(/malformed/i);
    expect(() => parseAggTradeLine(row('1700000000'))).toThrow(/malformed/i);
    expect(() => parseAggTradeLine(row('1700000000000.5'))).toThrow(/malformed/i);
    expect(() => parseAggTradeLine(row(String(Date.UTC(2100, 0, 1))))).toThrow(/malformed/i);
  });
});
