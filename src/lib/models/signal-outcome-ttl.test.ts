// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { signalOutcomeSchema } from './signal-outcome';

describe('signalOutcomeSchema retention', () => {
  it('declares no TTL index, so outcomes are permanent', () => {
    const ttl = signalOutcomeSchema
      .indexes()
      .filter(([, options]) => options && options.expireAfterSeconds !== undefined);
    expect(ttl).toEqual([]);
  });
});
