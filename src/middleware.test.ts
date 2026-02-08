// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from './middleware';

function makeRequest(
  pathname: string,
  cookies?: Record<string, string>
): NextRequest {
  const req = new NextRequest(`http://localhost${pathname}`);
  if (cookies) {
    for (const [name, value] of Object.entries(cookies)) {
      req.cookies.set(name, value);
    }
  }
  return req;
}

describe('middleware', () => {
  it('allows /login without authentication', () => {
    const res = middleware(makeRequest('/login'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('allows /register without authentication', () => {
    const res = middleware(makeRequest('/register'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('redirects unauthenticated requests to /login', () => {
    const res = middleware(makeRequest('/dashboard'));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/login');
  });

  it('includes callbackUrl in redirect', () => {
    const res = middleware(makeRequest('/dashboard/portfolio'));
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('callbackUrl')).toBe(
      '/dashboard/portfolio'
    );
  });

  it('allows requests with authjs.session-token cookie', () => {
    const res = middleware(
      makeRequest('/dashboard', { 'authjs.session-token': 'some-token' })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('allows requests with __Secure-authjs.session-token cookie', () => {
    const res = middleware(
      makeRequest('/dashboard', {
        '__Secure-authjs.session-token': 'some-token',
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });
});
