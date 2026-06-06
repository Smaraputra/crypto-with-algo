import { describe, expect, it } from 'vitest';
import { AuthToken } from './auth-token';

describe('AuthToken model', () => {
  it('exposes the expected schema paths', () => {
    const paths = AuthToken.schema.paths;
    expect(paths.userId).toBeDefined();
    expect(paths.type).toBeDefined();
    expect(paths.tokenHash).toBeDefined();
    expect(paths.expiresAt).toBeDefined();
  });

  it('restricts type to verify or reset', () => {
    const enumValues = AuthToken.schema.path('type').options.enum;
    expect(enumValues).toEqual(['verify', 'reset']);
  });

  it('declares a TTL index on expiresAt', () => {
    const indexes = AuthToken.schema.indexes() as Array<
      [Record<string, unknown>, { expireAfterSeconds?: number }]
    >;
    const ttl = indexes.find(([fields]) => 'expiresAt' in fields);
    expect(ttl).toBeDefined();
    expect(ttl?.[1]?.expireAfterSeconds).toBe(0);
  });
});
