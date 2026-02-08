// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock next-auth and its ecosystem before any imports
vi.mock('next-auth', () => ({
  default: vi.fn(() => ({
    handlers: { GET: vi.fn(), POST: vi.fn() },
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  })),
}));
vi.mock('next-auth/providers/credentials', () => ({
  default: vi.fn((config) => config),
}));
vi.mock('next-auth/providers/google', () => ({ default: vi.fn() }));
vi.mock('next-auth/providers/github', () => ({ default: vi.fn() }));
vi.mock('@auth/mongodb-adapter', () => ({
  MongoDBAdapter: vi.fn(),
}));

vi.mock('./mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('./models/user', () => ({
  User: { findOne: vi.fn() },
}));

vi.mock('bcryptjs', () => ({
  default: { compare: vi.fn() },
}));

import { loginSchema, authorizeCredentials } from './auth';
import { User } from './models/user';
import bcrypt from 'bcryptjs';
import NextAuth from 'next-auth';
import type { NextAuthConfig } from 'next-auth';

// Capture NextAuth config before clearAllMocks wipes call history.
// We know our auth.ts passes a plain object (not a function), so cast accordingly.
const nextAuthConfig = vi.mocked(NextAuth).mock.calls[0]?.[0] as
  | NextAuthConfig
  | undefined;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loginSchema', () => {
  it('accepts valid email and password', () => {
    const result = loginSchema.safeParse({
      email: 'test@example.com',
      password: 'secret123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing email', () => {
    const result = loginSchema.safeParse({ password: 'secret123' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid email format', () => {
    const result = loginSchema.safeParse({
      email: 'not-an-email',
      password: 'secret123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects password shorter than 6 characters', () => {
    const result = loginSchema.safeParse({
      email: 'test@example.com',
      password: '12345',
    });
    expect(result.success).toBe(false);
  });
});

describe('authorizeCredentials', () => {
  it('returns null for invalid schema input', async () => {
    const result = await authorizeCredentials({ email: 'bad', password: '1' });
    expect(result).toBeNull();
  });

  it('returns null when user is not found', async () => {
    vi.mocked(User.findOne).mockResolvedValue(null);

    const result = await authorizeCredentials({
      email: 'nobody@example.com',
      password: 'secret123',
    });
    expect(result).toBeNull();
  });

  it('returns null when user has no password (OAuth user)', async () => {
    vi.mocked(User.findOne).mockResolvedValue({
      _id: { toString: () => '123' },
      name: 'OAuth User',
      email: 'oauth@example.com',
      password: undefined,
    });

    const result = await authorizeCredentials({
      email: 'oauth@example.com',
      password: 'secret123',
    });
    expect(result).toBeNull();
  });

  it('returns null when password does not match', async () => {
    vi.mocked(User.findOne).mockResolvedValue({
      _id: { toString: () => '123' },
      name: 'Test User',
      email: 'test@example.com',
      password: '$2a$12$hashedpassword',
    });
    vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

    const result = await authorizeCredentials({
      email: 'test@example.com',
      password: 'wrongpass',
    });
    expect(result).toBeNull();
  });

  it('returns user object on correct credentials', async () => {
    vi.mocked(User.findOne).mockResolvedValue({
      _id: { toString: () => 'user-id-123' },
      name: 'Test User',
      email: 'test@example.com',
      password: '$2a$12$hashedpassword',
      image: 'https://example.com/avatar.jpg',
    });
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

    const result = await authorizeCredentials({
      email: 'test@example.com',
      password: 'correct123',
    });
    expect(result).toEqual({
      id: 'user-id-123',
      name: 'Test User',
      email: 'test@example.com',
      image: 'https://example.com/avatar.jpg',
    });
  });
});

describe('NextAuth configuration', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type CallbackFn = (...args: any[]) => Promise<any>;

  it('passes JWT callbacks that inject user.id into token', async () => {
    expect(nextAuthConfig).toBeDefined();

    const jwtCallback = nextAuthConfig!.callbacks!.jwt! as CallbackFn;
    const token = await jwtCallback({
      token: { sub: 'sub-123' },
      user: { id: 'user-id-456' },
    });
    expect(token.id).toBe('user-id-456');
  });

  it('passes JWT callback that preserves token when no user', async () => {
    const jwtCallback = nextAuthConfig!.callbacks!.jwt! as CallbackFn;

    const token = await jwtCallback({
      token: { sub: 'sub-123', id: 'existing-id' },
      user: undefined,
    });
    expect(token.id).toBe('existing-id');
  });

  it('passes session callback that injects token.id into session.user', async () => {
    const sessionCallback = nextAuthConfig!.callbacks!.session! as CallbackFn;

    const session = await sessionCallback({
      session: { user: { name: 'Test' } },
      token: { id: 'token-id-789' },
    });
    expect(session.user.id).toBe('token-id-789');
  });

  it('uses JWT session strategy', () => {
    expect(nextAuthConfig!.session!.strategy).toBe('jwt');
  });
});
