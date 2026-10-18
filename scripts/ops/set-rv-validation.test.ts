import { describe, expect, it } from 'vitest';
import { parseArgs } from './set-rv-validation';

describe('parseArgs', () => {
  it('parses status rejected with trimmed ref and default book', () => {
    const result = parseArgs(['--status', 'rejected', '--ref', '  R  ']);
    expect(result).toEqual({
      status: 'rejected',
      ref: 'R',
      dryRun: false,
      bookName: 'rv-v1',
      mongoUri: null,
    });
  });

  it('parses full options including dry-run, custom book and mongo-uri', () => {
    const result = parseArgs([
      '--status',
      'rejected',
      '--ref',
      'R',
      '--dry-run',
      '--book',
      'b',
      '--mongo-uri',
      'mongodb://x',
    ]);
    expect(result).toEqual({
      status: 'rejected',
      ref: 'R',
      dryRun: true,
      bookName: 'b',
      mongoUri: 'mongodb://x',
    });
  });

  it('parses unvalidated status with null ref', () => {
    const result = parseArgs(['--status', 'unvalidated']);
    expect(result.status).toBe('unvalidated');
    expect(result.ref).toBeNull();
    expect(result.dryRun).toBe(false);
    expect(result.bookName).toBe('rv-v1');
    expect(result.mongoUri).toBeNull();
  });

  it('throws when --status is missing', () => {
    expect(() => parseArgs([])).toThrow('status must be one of unvalidated, validated, rejected');
  });

  it('throws on bogus status', () => {
    expect(() => parseArgs(['--status', 'bogus'])).toThrow(
      'status must be one of unvalidated, validated, rejected'
    );
  });

  it('throws on status rejected with no ref', () => {
    expect(() => parseArgs(['--status', 'rejected'])).toThrow(
      '--ref is required for status rejected'
    );
  });

  it('throws on status rejected with whitespace-only ref', () => {
    expect(() => parseArgs(['--status', 'rejected', '--ref', '   '])).toThrow(
      '--ref is required for status rejected'
    );
  });

  it('throws on status unvalidated when ref is provided', () => {
    expect(() => parseArgs(['--status', 'unvalidated', '--ref', 'R'])).toThrow(
      '--ref must be omitted for status unvalidated'
    );
  });

  it('throws when --status has no value', () => {
    expect(() => parseArgs(['--status'])).toThrow('--status needs a value');
  });

  it('throws when --status is followed by another flag', () => {
    expect(() => parseArgs(['--status', '--dry-run'])).toThrow('--status needs a value');
  });

  it('throws on an unknown argument, so a mistyped --dry-run never writes', () => {
    expect(() => parseArgs(['--status', 'rejected', '--ref', 'R', '--dryrun'])).toThrow(
      'unknown argument --dryrun'
    );
    expect(() => parseArgs(['--status', 'rejected', '--ref', 'R', 'extra'])).toThrow('unknown argument extra');
  });
});
