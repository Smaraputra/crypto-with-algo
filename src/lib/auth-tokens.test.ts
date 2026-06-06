import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

vi.mock('@/lib/mongodb', () => ({ connectDB: vi.fn() }));
vi.mock('@/lib/models/auth-token', () => ({
  AuthToken: {
    deleteMany: vi.fn(),
    create: vi.fn(),
    findOne: vi.fn(),
    deleteOne: vi.fn(),
  },
}));

import { hashToken, createToken, consumeToken } from './auth-tokens';
import { AuthToken } from '@/lib/models/auth-token';

beforeEach(() => vi.clearAllMocks());

describe('hashToken', () => {
  it('produces a stable sha256 hex digest', () => {
    const expected = crypto.createHash('sha256').update('abc').digest('hex');
    expect(hashToken('abc')).toBe(expected);
  });
});

describe('createToken', () => {
  it('invalidates prior tokens of the same type and stores only the hash', async () => {
    const raw = await createToken('user1', 'verify', 3600);
    expect(AuthToken.deleteMany).toHaveBeenCalledWith({ userId: 'user1', type: 'verify' });
    const createArg = vi.mocked(AuthToken.create).mock.calls[0][0];
    expect(createArg.tokenHash).toBe(hashToken(raw));
    expect(createArg.tokenHash).not.toBe(raw);
    expect(createArg.type).toBe('verify');
    expect(createArg.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('consumeToken', () => {
  it('returns userId and deletes the token on a valid match', async () => {
    vi.mocked(AuthToken.findOne).mockResolvedValue({ _id: 't1', userId: { toString: () => 'user1' } });
    const result = await consumeToken('rawtoken', 'reset');
    expect(AuthToken.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ tokenHash: hashToken('rawtoken'), type: 'reset' })
    );
    expect(AuthToken.deleteOne).toHaveBeenCalledWith({ _id: 't1' });
    expect(result).toBe('user1');
  });

  it('returns null when no unexpired token matches', async () => {
    vi.mocked(AuthToken.findOne).mockResolvedValue(null);
    expect(await consumeToken('rawtoken', 'reset')).toBeNull();
    expect(AuthToken.deleteOne).not.toHaveBeenCalled();
  });
});
