import { describe, expect, it } from 'vitest';
import { createStrategySchema, updateStrategySchema } from './strategy';
import { mockCreateStrategyInput, mockInvalidWeights, mockWeights } from '@/__fixtures__/strategies';

describe('createStrategySchema', () => {
  it('accepts valid input', () => {
    const result = createStrategySchema.safeParse(mockCreateStrategyInput);
    expect(result.success).toBe(true);
  });

  it('rejects empty name', () => {
    const result = createStrategySchema.safeParse({
      ...mockCreateStrategyInput,
      name: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects name over 50 chars', () => {
    const result = createStrategySchema.safeParse({
      ...mockCreateStrategyInput,
      name: 'A'.repeat(51),
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty symbols array', () => {
    const result = createStrategySchema.safeParse({
      ...mockCreateStrategyInput,
      symbols: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 5 symbols', () => {
    const result = createStrategySchema.safeParse({
      ...mockCreateStrategyInput,
      symbols: ['A', 'B', 'C', 'D', 'E', 'F'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty intervals array', () => {
    const result = createStrategySchema.safeParse({
      ...mockCreateStrategyInput,
      intervals: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid interval value', () => {
    const result = createStrategySchema.safeParse({
      ...mockCreateStrategyInput,
      intervals: ['5m'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects weights that do not sum to 1.0', () => {
    const result = createStrategySchema.safeParse({
      ...mockCreateStrategyInput,
      weights: mockInvalidWeights,
    });
    expect(result.success).toBe(false);
  });

  it('accepts weights that sum close to 1.0 (floating point)', () => {
    const result = createStrategySchema.safeParse({
      ...mockCreateStrategyInput,
      weights: mockWeights,
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative weight values', () => {
    const result = createStrategySchema.safeParse({
      ...mockCreateStrategyInput,
      weights: { ...mockWeights, trend: -0.1 },
    });
    expect(result.success).toBe(false);
  });
});

describe('updateStrategySchema', () => {
  it('accepts partial input', () => {
    const result = updateStrategySchema.safeParse({ name: 'Updated' });
    expect(result.success).toBe(true);
  });

  it('accepts empty object', () => {
    const result = updateStrategySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('rejects invalid interval in partial update', () => {
    const result = updateStrategySchema.safeParse({ intervals: ['5m'] });
    expect(result.success).toBe(false);
  });
});
