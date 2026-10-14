// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RvSignal } from './rv-signal';
import { RvBook, RV_BOOK_NAME } from './rv-book';
import { RvStep } from './rv-step';

function uniqueIndexes(model: { schema: { indexes(): [Record<string, unknown>, Record<string, unknown>][] } }) {
  return model.schema.indexes().filter(([, opts]) => opts?.unique === true);
}

describe('rv-v1 models', () => {
  it('D22: each model declares exactly one unique index, on its natural key', () => {
    expect(RvSignal.schema.indexes()).toEqual([[{ version: 1, barTime: 1 }, expect.objectContaining({ unique: true })]]);
    expect(RvBook.schema.indexes()).toEqual([[{ bookName: 1 }, expect.objectContaining({ unique: true })]]);
    expect(RvStep.schema.indexes()).toEqual([[{ bookName: 1, barTime: 1 }, expect.objectContaining({ unique: true })]]);
    for (const model of [RvSignal, RvBook, RvStep]) expect(uniqueIndexes(model)).toHaveLength(1);
  });

  it('D23: no record carries the misleading rebalanced, peakLeverage or return7d fields', () => {
    for (const model of [RvSignal, RvBook, RvStep]) {
      const paths = Object.keys(model.schema.paths);
      for (const banned of ['rebalanced', 'peakLeverage', 'return7d', 'return14d']) {
        expect(paths.some((p) => p === banned || p.endsWith(`.${banned}`))).toBe(false);
      }
    }
  });

  it('names the book rv-v1 and starts it unvalidated', async () => {
    expect(RV_BOOK_NAME).toBe('rv-v1');
    const book = new RvBook({ bookName: RV_BOOK_NAME, version: 'rv-v1', startedAt: new Date(0) });
    expect(book.validationStatus).toBe('unvalidated');
    expect(book.validationRef).toBeNull();
    expect(book.lastStepBarTime).toBeNull();
    expect(book.leaseUntil).toBeNull();
    await expect(book.validate()).resolves.toBeUndefined();
  });

  it('rejects a validation status outside the three states', async () => {
    const book = new RvBook({ bookName: RV_BOOK_NAME, version: 'rv-v1', startedAt: new Date(0), validationStatus: 'passed' });
    await expect(book.validate()).rejects.toThrow(/validationStatus/);
  });

  it('keeps empty position maps and target maps instead of minimising them away', () => {
    expect(RvBook.schema.get('minimize')).toBe(false);
    expect(RvStep.schema.get('minimize')).toBe(false);
    expect(RvSignal.schema.get('minimize')).toBe(false);
  });
});
