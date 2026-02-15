import { describe, expect, it } from 'vitest';
import { cn, escapeRegex } from './utils';

describe('cn', () => {
  it('merges multiple class strings', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('filters falsy values', () => {
    expect(cn('foo', false, null, undefined, 0, '', 'bar')).toBe('foo bar');
  });

  it('handles conditional classes', () => {
    const isActive = true;
    const isDisabled = false;
    expect(cn('base', isActive && 'active', isDisabled && 'disabled')).toBe(
      'base active'
    );
  });

  it('resolves Tailwind conflicts (last wins)', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
    expect(cn('bg-primary', 'bg-secondary')).toBe('bg-secondary');
  });

  it('preserves non-conflicting classes', () => {
    expect(cn('p-2', 'mx-4', 'text-sm')).toBe('p-2 mx-4 text-sm');
  });

  it('handles empty input', () => {
    expect(cn()).toBe('');
  });

  it('handles undefined input', () => {
    expect(cn(undefined)).toBe('');
  });

  it('handles object syntax from clsx', () => {
    expect(cn({ 'font-bold': true, 'text-red-500': false })).toBe('font-bold');
  });

  it('handles array syntax from clsx', () => {
    expect(cn(['foo', 'bar'])).toBe('foo bar');
  });
});

describe('escapeRegex', () => {
  it('escapes all special regex characters', () => {
    expect(escapeRegex('.*+?^${}()|[]\\')).toBe(
      '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\'
    );
  });

  it('returns plain string unchanged', () => {
    expect(escapeRegex('breakout')).toBe('breakout');
  });

  it('escapes ReDoS payloads', () => {
    const malicious = '(a+)+b';
    const escaped = escapeRegex(malicious);
    expect(escaped).toBe('\\(a\\+\\)\\+b');
    // Verify it matches literally, not as a regex pattern
    const re = new RegExp(escaped);
    expect(re.test('(a+)+b')).toBe(true);
    expect(re.test('aaab')).toBe(false);
  });

  it('handles empty string', () => {
    expect(escapeRegex('')).toBe('');
  });

  it('escapes dots in domain-like strings', () => {
    expect(escapeRegex('api.binance.com')).toBe('api\\.binance\\.com');
  });
});
