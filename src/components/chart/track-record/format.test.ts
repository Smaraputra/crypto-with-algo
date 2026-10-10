import { describe, expect, it } from 'vitest';

import { pointMeasures } from '@/lib/signals/track-record/measures';
import type { PointMeasures } from '@/lib/signals/track-record/types';

import {
  assessable,
  count,
  formatDate,
  formatMonth,
  monthsBelowZero,
  netSentence,
  rightSentence,
  share,
  signed,
  verdictText,
} from './format';

const measures = (over: Partial<PointMeasures>): PointMeasures => ({ ...pointMeasures([], 0.16), ...over });

describe('number formats', () => {
  it('formats shares, signed returns and counts', () => {
    expect(share(0.44427)).toBe('44.4%');
    expect(share(null)).toBe('n/a');
    expect(signed(0.4213)).toBe('+0.42%');
    expect(signed(-0.243)).toBe('-0.24%');
    expect(signed(-0.0001)).toBe('-0.00%');
    expect(signed(null)).toBe('n/a');
    expect(count(1553180)).toBe('1,553,180');
  });

  it('formats dates and months in UTC', () => {
    expect(formatDate(Date.UTC(2026, 9, 1, 18))).toBe('1 Oct 2026');
    expect(formatMonth('2026-03')).toBe('Mar');
    expect(formatMonth('2026-03', true)).toBe('Mar 2026');
  });
});

describe('rightSentence', () => {
  it('sets the right-rate against the coin flip and the break-even rate', () => {
    expect(rightSentence(measures({ right: 0.4443, breakEven: 0.5178 }), 0.16)).toBe(
      'Right 44.4% of the time. A coin flip is right 50%. Breaking even after 0.16% costs needed about 51.8%.'
    );
  });

  it('says plainly when costs cannot be beaten at any right-rate', () => {
    expect(rightSentence(measures({ right: 0.6, breakEven: 1.2 }), 0.2)).toContain(
      'could not be beaten even by calls that were always right'
    );
  });

  it('handles a year without calls or without a break-even', () => {
    expect(rightSentence(measures({}), 0.16)).toBe('No buy or sell call in this year.');
    expect(rightSentence(measures({ right: 1, breakEven: null }), 0.16)).toBe('Right 100.0% of the time. A coin flip is right 50%.');
  });
});

describe('netSentence', () => {
  it('says lost or made with the size per call', () => {
    expect(netSentence(measures({ net: -0.2431 }))).toBe('Acting on every call lost 0.24% per call on average after costs.');
    expect(netSentence(measures({ net: 0.05 }))).toBe('Acting on every call made 0.05% per call on average after costs.');
    expect(netSentence(measures({ net: null }))).toBe('');
  });
});

describe('assessable', () => {
  it('needs 30 calls on each side', () => {
    expect(assessable(measures({ buyN: 30, sellN: 30 }))).toBe(true);
    expect(assessable(measures({ buyN: 19, sellN: 114 }))).toBe(false);
  });
});

describe('verdictText', () => {
  it('reads every locked verdict in words', () => {
    expect(verdictText('NO DETECTABLE EDGE')).toBe('no detectable edge');
    expect(verdictText('NOT ASSESSABLE')).toBe('too few calls to judge');
    expect(verdictText('WRONG-WAY')).toBe('wrong more often than chance');
    expect(verdictText('PAYS')).toBe('paid after costs');
    expect(verdictText('RIGHT')).toBe('right more often than chance');
  });
});

describe('monthsBelowZero', () => {
  it('counts only months that had calls', () => {
    expect(monthsBelowZero([{ net: -0.1 }, { net: 0.2 }, { net: null }, { net: -0.3 }])).toEqual({ below: 2, withCalls: 3 });
  });
});
