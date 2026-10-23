import { describe, expect, it } from 'vitest';
import { bookTitle, INTERVAL_WORDS, STYLE_LABELS } from './labels';

describe('labels', () => {
  describe('bookTitle', () => {
    it('formats scalping:5m as "Scalping, 5 minutes"', () => {
      expect(bookTitle('scalping:5m')).toBe('Scalping, 5 minutes');
    });

    it('formats day_trading:1h as "Day trading, 1 hour"', () => {
      expect(bookTitle('day_trading:1h')).toBe('Day trading, 1 hour');
    });

    it('falls back to the raw part when style or interval is unknown', () => {
      expect(bookTitle('unknown:5m')).toBe('unknown, 5 minutes');
      expect(bookTitle('scalping:unknown')).toBe('Scalping, unknown');
      expect(bookTitle('unknown:unknown')).toBe('unknown, unknown');
      expect(bookTitle('unknown')).toBe('unknown');
    });

    it('handles empty string', () => {
      expect(bookTitle('')).toBe('');
    });
  });

  describe('STYLE_LABELS', () => {
    it('has labels for all trading styles', () => {
      expect(STYLE_LABELS.scalping).toBe('Scalping');
      expect(STYLE_LABELS.day_trading).toBe('Day trading');
      expect(STYLE_LABELS.swing_trading).toBe('Swing trading');
      expect(STYLE_LABELS.position_trading).toBe('Position trading');
    });
  });

  describe('INTERVAL_WORDS', () => {
    it('maps intervals to spoken words', () => {
      expect(INTERVAL_WORDS['5m']).toBe('5 minutes');
      expect(INTERVAL_WORDS['15m']).toBe('15 minutes');
      expect(INTERVAL_WORDS['1h']).toBe('1 hour');
      expect(INTERVAL_WORDS['4h']).toBe('4 hours');
      expect(INTERVAL_WORDS['1d']).toBe('1 day');
    });
  });
});
