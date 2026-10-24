'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { loginWithCredentials } from '@/lib/auth-forms/flows';
import { loginSchema, safeCallbackUrl } from '@/lib/auth-forms/schemas';

export interface LoginFormProps {
  callbackUrl?: string | null;
}

export function LoginForm({ callbackUrl }: LoginFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const rawCallback = callbackUrl ?? searchParams?.get('callbackUrl');
  const destination = safeCallbackUrl(rawCallback);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    setNeedsVerification(false);

    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      const errors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as string;
        if (field && !errors[field]) {
          errors[field] = issue.message;
        }
      }
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    setIsSubmitting(true);

    try {
      const res = await loginWithCredentials({ email, password });
      if (!res.ok) {
        setServerError(res.message);
        if (res.needsVerification) {
          setNeedsVerification(true);
        }
        return;
      }

      router.push(destination);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOAuth = (provider: 'google' | 'github') => {
    signIn(provider, { callbackUrl: destination });
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        {serverError && (
          <div
            role="alert"
            className="p-3 rounded-[12px] bg-down/10 border border-down/30 text-down text-[14px] font-medium space-y-2"
          >
            <p>{serverError}</p>
            {needsVerification && (
              <p className="text-[13px]">
                <Link
                  href="/verify-email"
                  className="underline hover:text-foreground font-normal"
                >
                  Send a new verification email
                </Link>
              </p>
            )}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="login-email"
            className="text-[14px] font-medium text-foreground"
          >
            Email
          </label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (fieldErrors.email) setFieldErrors((prev) => ({ ...prev, email: '' }));
              if (serverError) setServerError(null);
            }}
            aria-invalid={!!fieldErrors.email}
            aria-describedby={fieldErrors.email ? 'login-email-error' : undefined}
            className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-medium text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
          />
          {fieldErrors.email && (
            <p id="login-email-error" role="alert" className="text-[13px] text-down">
              {fieldErrors.email}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label
              htmlFor="login-password"
              className="text-[14px] font-medium text-foreground"
            >
              Password
            </label>
            <Link
              href="/forgot-password"
              className="inline-flex items-center min-h-[44px] text-[13px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Forgot password?
            </Link>
          </div>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (fieldErrors.password) setFieldErrors((prev) => ({ ...prev, password: '' }));
              if (serverError) setServerError(null);
            }}
            aria-invalid={!!fieldErrors.password}
            aria-describedby={fieldErrors.password ? 'login-password-error' : undefined}
            className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-medium text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
          />
          {fieldErrors.password && (
            <p id="login-password-error" role="alert" className="text-[13px] text-down">
              {fieldErrors.password}
            </p>
          )}
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full min-h-[44px] rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold px-6 transition-colors disabled:opacity-50 cursor-pointer"
        >
          {isSubmitting ? 'Signing in...' : 'Sign in'}
        </button>
      </form>

      <div className="relative my-6">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t border-line" />
        </div>
        <div className="relative flex justify-center text-[13px]">
          <span className="bg-background px-3 text-muted-foreground">or</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => handleOAuth('google')}
          className="min-h-[44px] rounded-[12px] border border-edge bg-background hover:bg-card text-foreground font-medium px-4 text-[14px] transition-colors cursor-pointer"
        >
          Google
        </button>
        <button
          type="button"
          onClick={() => handleOAuth('github')}
          className="min-h-[44px] rounded-[12px] border border-edge bg-background hover:bg-card text-foreground font-medium px-4 text-[14px] transition-colors cursor-pointer"
        >
          GitHub
        </button>
      </div>

      <p className="mt-6 text-center text-[13px] text-muted-foreground">
        No account yet?{' '}
        <Link
          href="/register"
          className="text-foreground underline hover:opacity-80 font-medium"
        >
          Create one
        </Link>
      </p>
    </div>
  );
}
