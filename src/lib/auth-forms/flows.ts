import { signIn } from 'next-auth/react';
import { loginSchema, registerSchema, resetSchema } from './schemas';

export interface AuthFlowDeps {
  fetchImpl?: typeof fetch;
  signInImpl?: typeof signIn;
}

export interface LoginParams {
  email: string;
  password: string;
}

export interface RegisterAccountParams {
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  tosAccepted: unknown;
  turnstileToken?: string;
}

export interface RequestPasswordResetParams {
  email: string;
  turnstileToken?: string;
}

export interface ResetPasswordParams {
  token: string;
  password: string;
  confirm: string;
}

export interface ResendVerificationParams {
  email: string;
  turnstileToken?: string | null;
}

export async function loginWithCredentials(
  params: LoginParams,
  deps?: AuthFlowDeps
): Promise<{ ok: true } | { ok: false; message: string; needsVerification?: boolean }> {
  const parsed = loginSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0].message };
  }

  const signInFn = deps?.signInImpl ?? signIn;
  const result = await signInFn('credentials', {
    email: params.email,
    password: params.password,
    redirect: false,
  });

  if (result?.error) {
    const code = (result as { code?: string }).code;
    if (code === 'email_not_verified') {
      return {
        ok: false,
        message: 'Please verify your email before signing in.',
        needsVerification: true,
      };
    }
    return { ok: false, message: 'Invalid email or password' };
  }

  return { ok: true };
}

export async function registerAccount(
  params: RegisterAccountParams,
  deps?: AuthFlowDeps
): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = registerSchema.safeParse({
    name: params.name,
    email: params.email,
    password: params.password,
    confirmPassword: params.confirmPassword,
    tosAccepted: params.tosAccepted,
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0].message };
  }

  const fetchFn = deps?.fetchImpl ?? fetch;
  const res = await fetchFn('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: params.name,
      email: params.email,
      password: params.password,
      tosAccepted: params.tosAccepted,
      turnstileToken: params.turnstileToken,
    }),
  });

  if (!res.ok) {
    let message = 'Registration failed';
    try {
      const body = await res.json();
      if (body && typeof body === 'object' && body.error) {
        message = body.error;
      }
    } catch {
      // non-JSON body
    }
    return { ok: false, message };
  }

  return { ok: true };
}

export async function requestPasswordReset(
  params: RequestPasswordResetParams,
  deps?: AuthFlowDeps
): Promise<{ ok: true }> {
  const fetchFn = deps?.fetchImpl ?? fetch;
  try {
    await fetchFn('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: params.email,
        turnstileToken: params.turnstileToken,
      }),
    });
  } catch {
    // swallow every error
  }
  return { ok: true };
}

export async function resetPassword(
  params: ResetPasswordParams,
  deps?: AuthFlowDeps
): Promise<{ ok: true } | { ok: false; message: string }> {
  const parsed = resetSchema.safeParse({
    password: params.password,
    confirm: params.confirm,
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0].message };
  }

  const fetchFn = deps?.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchFn('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: params.token,
        password: params.password,
      }),
    });
  } catch {
    return { ok: false, message: 'Network error. Please try again.' };
  }

  if (!res.ok) {
    let message = 'Something went wrong. Please try again.';
    try {
      const data = await res.json();
      if (data && typeof data === 'object' && data.error != null) {
        message = data.error;
      }
    } catch {
      // not JSON
    }
    return { ok: false, message };
  }

  return { ok: true };
}

export async function verifyEmailToken(
  token: string,
  deps?: AuthFlowDeps
): Promise<'success' | 'error'> {
  const fetchFn = deps?.fetchImpl ?? fetch;
  try {
    const res = await fetchFn('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    return res.ok ? 'success' : 'error';
  } catch {
    return 'error';
  }
}

export async function resendVerification(
  params: ResendVerificationParams,
  deps?: AuthFlowDeps
): Promise<{ ok: boolean }> {
  if (!params.turnstileToken) {
    return { ok: false };
  }

  const fetchFn = deps?.fetchImpl ?? fetch;
  try {
    await fetchFn('/api/auth/verify-email/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: params.email,
        turnstileToken: params.turnstileToken,
      }),
    });
  } catch {
    // swallow errors
  }
  return { ok: true };
}

export async function recordConsent(
  deps?: AuthFlowDeps
): Promise<{ ok: true } | { ok: false; message: string }> {
  const fetchFn = deps?.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchFn('/api/auth/consent', { method: 'POST' });
  } catch {
    return { ok: false, message: 'Network error. Please try again.' };
  }

  if (!res.ok) {
    let message = 'Failed to record consent';
    try {
      const data = await res.json();
      if (data && typeof data === 'object' && data.error) {
        message = data.error;
      }
    } catch {
      // not JSON
    }
    return { ok: false, message };
  }

  return { ok: true };
}
