// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/mongodb', () => ({
  connectDB: vi.fn(),
}));

vi.mock('@/lib/models/user', () => ({
  User: {
    findOne: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('bcryptjs', () => ({
  default: { hash: vi.fn() },
}));

vi.mock('@/lib/rate-limit', () => ({
  createRateLimiter: vi.fn(() => 'mock-limiter'),
  rateLimit: vi.fn(() => null),
}));

import { POST } from './route';
import { User } from '@/lib/models/user';
import bcrypt from 'bcryptjs';
import { rateLimit } from '@/lib/rate-limit';

function makeRequest(body?: unknown): NextRequest {
  if (body === undefined) {
    // Simulate malformed JSON
    return new NextRequest('http://localhost/api/auth/register', {
      method: 'POST',
      body: 'not json',
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return new NextRequest('http://localhost/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('ALLOW_REGISTRATION', 'true');
  vi.mocked(rateLimit).mockResolvedValue(null);
});

describe('POST /api/auth/register', () => {
  it('returns 403 when registration is disabled', async () => {
    vi.stubEnv('ALLOW_REGISTRATION', '');
    const req = makeRequest({
      name: 'Test',
      email: 'test@example.com',
      password: 'Secret1!',
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error).toBe('Registration is currently disabled');
  });

  it('returns 400 for malformed JSON', async () => {
    const req = makeRequest();
    const res = await POST(req);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Invalid JSON body');
  });

  it('returns 400 for missing required fields', async () => {
    const req = makeRequest({ email: 'test@example.com' });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid email', async () => {
    const req = makeRequest({
      name: 'Test',
      email: 'not-email',
      password: 'Secret1!',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 400 for short password', async () => {
    const req = makeRequest({
      name: 'Test',
      email: 'test@example.com',
      password: '12345',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('returns 409 for duplicate email', async () => {
    vi.mocked(User.findOne).mockResolvedValue({ email: 'dupe@example.com' });

    const req = makeRequest({
      name: 'Test',
      email: 'dupe@example.com',
      password: 'Secret1!',
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('Email already registered');
  });

  it('returns 201 on successful registration', async () => {
    vi.mocked(User.findOne).mockResolvedValue(null);
    vi.mocked(bcrypt.hash).mockResolvedValue('$2a$12$hashed' as never);
    vi.mocked(User.create).mockResolvedValue({
      _id: { toString: () => 'new-user-id' },
      name: 'Alice',
      email: 'alice@example.com',
    } as never);

    const req = makeRequest({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Secret1!',
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data).toEqual({
      id: 'new-user-id',
      name: 'Alice',
      email: 'alice@example.com',
    });
  });

  it('hashes password with 12 salt rounds', async () => {
    vi.mocked(User.findOne).mockResolvedValue(null);
    vi.mocked(bcrypt.hash).mockResolvedValue('$2a$12$hashed' as never);
    vi.mocked(User.create).mockResolvedValue({
      _id: { toString: () => 'id' },
      name: 'Test',
      email: 'test@example.com',
    } as never);

    const req = makeRequest({
      name: 'Test',
      email: 'test@example.com',
      password: 'MyPass1!',
    });
    await POST(req);

    expect(bcrypt.hash).toHaveBeenCalledWith('MyPass1!', 12);
  });

  it('returns 409 on concurrent duplicate email (MongoDB 11000)', async () => {
    vi.mocked(User.findOne).mockResolvedValue(null);
    vi.mocked(bcrypt.hash).mockResolvedValue('$2a$12$hashed' as never);
    const duplicateError = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    vi.mocked(User.create).mockRejectedValue(duplicateError);

    const req = makeRequest({
      name: 'Test',
      email: 'race@example.com',
      password: 'Secret1!',
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error).toBe('Email already registered');
  });

  it('returns 500 for non-duplicate database errors', async () => {
    vi.mocked(User.findOne).mockResolvedValue(null);
    vi.mocked(bcrypt.hash).mockResolvedValue('$2a$12$hashed' as never);
    vi.mocked(User.create).mockRejectedValue(new Error('Connection timeout'));

    const req = makeRequest({
      name: 'Test',
      email: 'test@example.com',
      password: 'Secret1!',
    });
    const res = await POST(req);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe('Internal server error');
  });

  it('returns 429 when rate limited', async () => {
    const { NextResponse } = await import('next/server');
    vi.mocked(rateLimit).mockResolvedValue(
      NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    );

    const req = makeRequest({
      name: 'Test',
      email: 'test@example.com',
      password: 'Secret1!',
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
  });
});
