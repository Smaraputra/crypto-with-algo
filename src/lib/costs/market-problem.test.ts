import { describe, expect, it } from 'vitest';
import { marketProblemText } from './market-problem';

describe('marketProblemText', () => {
  it('translates venue_unreachable', () => {
    expect(marketProblemText('venue_unreachable')).toBe('the exchange could not be reached');
  });

  it('translates venue_rate_limited', () => {
    expect(marketProblemText('venue_rate_limited')).toBe('the exchange is rate limiting requests');
  });

  it('translates unknown_symbol', () => {
    expect(marketProblemText('unknown_symbol')).toBe('this perpetual is not trading');
  });

  it('translates rate_limited', () => {
    expect(marketProblemText('rate_limited')).toBe('too many checks in a minute, try again shortly');
  });

  it('falls back to default message when code is undefined', () => {
    expect(marketProblemText(undefined)).toBe('the request failed');
  });

  it('falls back to default message for unknown codes', () => {
    expect(marketProblemText('unknown_code')).toBe('the request failed');
  });
});
