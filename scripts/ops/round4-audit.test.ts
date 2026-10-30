// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseAuditArchive, validateOutputPaths } from './round4-audit';

describe('Round 4 read-only CLI', () => {
  it('counts parser-dropped rows and malformed volume instead of treating them as matches', () => {
    const csv = [
      'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore',
      '1640995200000,10,11,9,10,20,1640998799999,200,10,5,50,0',
      '1640998800000,no,11,9,10,20,1641002399999,200,10,5,50,0',
      '1641002400000,10,11,9,10,bad,1641005999999,200,10,5,50,0',
      'bad,10,11,9,10,20,1641005999999,200,10,5,50,0',
    ].join('\n');
    expect(parseAuditArchive(csv)).toMatchObject({
      invalidLines: 3,
      bars: [{ timestamp: 1640995200000, close: 10, volume: 20, takerBuyVolume: 5 }],
    });
    expect(parseAuditArchive(csv).bars).toHaveLength(1);
  });
  it('rejects cache/output collisions and implicit or relative archive cache directories', () => {
    expect(() => validateOutputPaths('/tmp/out.json', 'relative')).toThrow('absolute');
    expect(() => validateOutputPaths('/tmp/out.json', '/tmp/out.json')).toThrow('overlap');
    expect(() => validateOutputPaths('/tmp/archive/out.json', '/tmp/archive')).toThrow('overlap');
    expect(validateOutputPaths('/tmp/out.json')).toMatchObject({
      out: '/tmp/out.json',
      rows: '/tmp/out.json.rows.jsonl',
    });
  });
});
