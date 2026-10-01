// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { SIGNAL_TIERS } from '@/types/signal';
import { TIER_DISPLAY_LABELS, tierDisplayLabel } from './tier-labels';

describe('tier display labels', () => {
  it('labels every tier key', () => {
    for (const tier of SIGNAL_TIERS) {
      expect(TIER_DISPLAY_LABELS[tier]).toBeTruthy();
    }
  });

  it('describes the score and never reads as advice', () => {
    for (const label of Object.values(TIER_DISPLAY_LABELS)) {
      expect(label).not.toMatch(/\b(buy|sell)\b/i);
    }
    expect(tierDisplayLabel('strong_buy')).toBe('Strong long score');
    expect(tierDisplayLabel('strong_sell')).toBe('Strong short score');
  });

  it('falls back to readable words for an unknown key', () => {
    expect(tierDisplayLabel('some_new_tier')).toBe('some new tier');
  });
});
