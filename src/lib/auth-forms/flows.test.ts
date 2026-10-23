import { describe, expect, it, vi } from 'vitest';
import {
  loginWithCredentials,
  recordConsent,
  registerAccount,
  requestPasswordReset,
  resendVerification,
  resetPassword,
  verifyEmailToken,
} from './flows';

describe('loginWithCredentials', () => {
  it('returns validation error without calling signIn on invalid email', async () => {
    const signInImpl = vi.fn();
    const result = await loginWithCredentials(
      { email: 'bad-email', password: 'password123' },
      { signInImpl: signInImpl as never }
    );

    expect(result).toEqual({
      ok: false,
      message: 'Invalid email address',
    });
    expect(signInImpl).not.toHaveBeenCalled();
  });

  it('returns validation error without calling signIn on short password', async () => {
    const signInImpl = vi.fn();
    const result = await loginWithCredentials(
      { email: 'valid@example.com', password: '123' },
      { signInImpl: signInImpl as never }
    );

    expect(result).toEqual({
      ok: false,
      message: 'Password must be at least 6 characters',
    });
    expect(signInImpl).not.toHaveBeenCalled();
  });

  it('calls signIn and returns ok: true on successful credentials', async () => {
    const signInImpl = vi.fn().mockResolvedValue({ error: null });
    const result = await loginWithCredentials(
      { email: 'user@example.com', password: 'password123' },
      { signInImpl: signInImpl as never }
    );

    expect(signInImpl).toHaveBeenCalledWith('credentials', {
      email: 'user@example.com',
      password: 'password123',
      redirect: false,
    });
    expect(result).toEqual({ ok: true });
  });

  it('returns needsVerification when signIn returns email_not_verified code', async () => {
    const signInImpl = vi.fn().mockResolvedValue({
      error: 'CredentialsSignin',
      code: 'email_not_verified',
    });
    const result = await loginWithCredentials(
      { email: 'unverified@example.com', password: 'password123' },
      { signInImpl: signInImpl as never }
    );

    expect(result).toEqual({
      ok: false,
      message: 'Please verify your email before signing in.',
      needsVerification: true,
    });
  });

  it('returns invalid email or password on generic credentials error', async () => {
    const signInImpl = vi.fn().mockResolvedValue({
      error: 'CredentialsSignin',
    });
    const result = await loginWithCredentials(
      { email: 'user@example.com', password: 'wrongpassword' },
      { signInImpl: signInImpl as never }
    );

    expect(result).toEqual({
      ok: false,
      message: 'Invalid email or password',
    });
  });
});

describe('registerAccount', () => {
  const validForm = {
    name: 'Alice',
    email: 'alice@example.com',
    password: 'Password123!',
    confirmPassword: 'Password123!',
    tosAccepted: true,
    turnstileToken: 'turn-token-123',
  };

  it('returns validation error without calling fetch when validation fails', async () => {
    const fetchImpl = vi.fn();
    const result = await registerAccount(
      { ...validForm, confirmPassword: 'DifferentPassword123!' },
      { fetchImpl: fetchImpl as never }
    );

    expect(result).toEqual({
      ok: false,
      message: 'Passwords do not match',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs exact body and returns ok: true on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const result = await registerAccount(validForm, { fetchImpl: fetchImpl as never });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/auth/register');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      name: 'Alice',
      email: 'alice@example.com',
      password: 'Password123!',
      tosAccepted: true,
      turnstileToken: 'turn-token-123',
    });
    expect(result).toEqual({ ok: true });
  });

  it('returns API error message when registration fails with JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Email already registered' }), {
        status: 400,
      })
    );

    const result = await registerAccount(validForm, { fetchImpl: fetchImpl as never });

    expect(result).toEqual({
      ok: false,
      message: 'Email already registered',
    });
  });

  it('returns default Registration failed when response is not JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('Internal Server Error', { status: 500 })
    );

    const result = await registerAccount(validForm, { fetchImpl: fetchImpl as never });

    expect(result).toEqual({
      ok: false,
      message: 'Registration failed',
    });
  });
});

describe('requestPasswordReset', () => {
  it('POSTs exact body to /api/auth/forgot-password and returns ok: true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const result = await requestPasswordReset(
      { email: 'user@example.com', turnstileToken: 'token-xyz' },
      { fetchImpl: fetchImpl as never }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/auth/forgot-password');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      email: 'user@example.com',
      turnstileToken: 'token-xyz',
    });
    expect(result).toEqual({ ok: true });
  });

  it('swallows fetch network error and returns ok: true', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('Network offline'));

    const result = await requestPasswordReset(
      { email: 'user@example.com', turnstileToken: 'token-xyz' },
      { fetchImpl: fetchImpl as never }
    );

    expect(result).toEqual({ ok: true });
  });

  it('swallows non-ok response and returns ok: true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('Server Error', { status: 500 })
    );

    const result = await requestPasswordReset(
      { email: 'user@example.com', turnstileToken: 'token-xyz' },
      { fetchImpl: fetchImpl as never }
    );

    expect(result).toEqual({ ok: true });
  });
});

describe('resetPassword', () => {
  const validParams = {
    token: 'reset-tok-123',
    password: 'NewPassword123!',
    confirm: 'NewPassword123!',
  };

  it('returns validation error without calling fetch when confirmation mismatches', async () => {
    const fetchImpl = vi.fn();
    const result = await resetPassword(
      { ...validParams, confirm: 'Mismatch123!' },
      { fetchImpl: fetchImpl as never }
    );

    expect(result).toEqual({
      ok: false,
      message: 'Passwords do not match',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs exact body and returns ok: true on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const result = await resetPassword(validParams, {
      fetchImpl: fetchImpl as never,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/auth/reset-password');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      token: 'reset-tok-123',
      password: 'NewPassword123!',
    });
    expect(result).toEqual({ ok: true });
  });

  it('returns API error message when reset fails with JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Reset token expired' }), {
        status: 400,
      })
    );

    const result = await resetPassword(validParams, {
      fetchImpl: fetchImpl as never,
    });

    expect(result).toEqual({
      ok: false,
      message: 'Reset token expired',
    });
  });

  it('returns fallback message when not ok response is not JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('Error', { status: 500 })
    );

    const result = await resetPassword(validParams, {
      fetchImpl: fetchImpl as never,
    });

    expect(result).toEqual({
      ok: false,
      message: 'Something went wrong. Please try again.',
    });
  });

  it('returns network error message when fetch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await resetPassword(validParams, {
      fetchImpl: fetchImpl as never,
    });

    expect(result).toEqual({
      ok: false,
      message: 'Network error. Please try again.',
    });
  });
});

describe('verifyEmailToken', () => {
  it('POSTs exact body to /api/auth/verify-email and resolves success when ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const result = await verifyEmailToken('verify-token-456', {
      fetchImpl: fetchImpl as never,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/auth/verify-email');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ token: 'verify-token-456' });
    expect(result).toBe('success');
  });

  it('resolves error when response is not ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('Bad request', { status: 400 })
    );

    const result = await verifyEmailToken('bad-token', {
      fetchImpl: fetchImpl as never,
    });

    expect(result).toBe('error');
  });

  it('resolves error when fetch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('Connection failure'));

    const result = await verifyEmailToken('fail-token', {
      fetchImpl: fetchImpl as never,
    });

    expect(result).toBe('error');
  });
});

describe('resendVerification', () => {
  it('returns ok: false and sends nothing when turnstileToken is empty', async () => {
    const fetchImpl = vi.fn();

    const resultEmpty = await resendVerification(
      { email: 'user@example.com', turnstileToken: '' },
      { fetchImpl: fetchImpl as never }
    );
    expect(resultEmpty).toEqual({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();

    const resultNull = await resendVerification(
      { email: 'user@example.com', turnstileToken: null },
      { fetchImpl: fetchImpl as never }
    );
    expect(resultNull).toEqual({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs exact body to /api/auth/verify-email/resend and returns ok: true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const result = await resendVerification(
      { email: 'user@example.com', turnstileToken: 'turn-token-valid' },
      { fetchImpl: fetchImpl as never }
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/auth/verify-email/resend');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({
      email: 'user@example.com',
      turnstileToken: 'turn-token-valid',
    });
    expect(result).toEqual({ ok: true });
  });

  it('swallows errors and returns ok: true when fetch fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('Network error'));

    const result = await resendVerification(
      { email: 'user@example.com', turnstileToken: 'turn-token-valid' },
      { fetchImpl: fetchImpl as never }
    );

    expect(result).toEqual({ ok: true });
  });
});

describe('recordConsent', () => {
  it('POSTs to /api/auth/consent and returns ok: true on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 })
    );

    const result = await recordConsent({ fetchImpl: fetchImpl as never });

    expect(fetchImpl).toHaveBeenCalledWith('/api/auth/consent', {
      method: 'POST',
    });
    expect(result).toEqual({ ok: true });
  });

  it('returns API error when response is not ok with JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Consent rejected' }), {
        status: 400,
      })
    );

    const result = await recordConsent({ fetchImpl: fetchImpl as never });

    expect(result).toEqual({
      ok: false,
      message: 'Consent rejected',
    });
  });

  it('returns default error message when response is not JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('Gateway Timeout', { status: 504 })
    );

    const result = await recordConsent({ fetchImpl: fetchImpl as never });

    expect(result).toEqual({
      ok: false,
      message: 'Failed to record consent',
    });
  });

  it('returns network error message when fetch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('Network failure'));

    const result = await recordConsent({ fetchImpl: fetchImpl as never });

    expect(result).toEqual({
      ok: false,
      message: 'Network error. Please try again.',
    });
  });
});
