'use client';

import React, { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { TurnstileWidget } from '@/components/auth/turnstile';
import { resendVerification, verifyEmailToken } from '@/lib/auth-forms/flows';

export interface VerifyEmailProps {
  token?: string | null;
}

export function VerifyEmail({ token: propToken }: VerifyEmailProps) {
  const searchParams = useSearchParams();
  const token = propToken ?? searchParams?.get('token');

  const [status, setStatus] = useState<'idle' | 'verifying' | 'success' | 'error'>(
    token ? 'verifying' : 'idle'
  );

  const [resendEmail, setResendEmail] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [resendSent, setResendSent] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  const calledRef = useRef(false);

  useEffect(() => {
    if (!token || calledRef.current) return;
    calledRef.current = true;

    Promise.resolve(verifyEmailToken(token))
      .then((result) => {
        if (result) setStatus(result);
      })
      .catch(() => {
        setStatus('error');
      });
  }, [token]);

  const handleResendSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!turnstileToken || isResending) return;

    if (!resendEmail || !resendEmail.includes('@')) {
      setResendError('Invalid email address');
      return;
    }

    setResendError(null);
    setIsResending(true);

    try {
      await resendVerification({ email: resendEmail, turnstileToken });
      setResendSent(true);
    } catch {
      // Swallow error: neutral message is shown regardless
      setResendSent(true);
    } finally {
      setIsResending(false);
    }
  };

  if (status === 'verifying') {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <h2 className="text-[20px] font-semibold text-foreground">
            Verifying your email
          </h2>
          <p className="text-[14px] text-muted-foreground">
            Please wait while we verify your email address.
          </p>
        </div>
        <div
          data-testid="verifying-placeholder"
          className="h-10 w-full rounded-[12px] bg-muted animate-pulse"
          aria-hidden="true"
        />
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <h2 className="text-[20px] font-semibold text-foreground">
            Email verified
          </h2>
          <p className="text-[14px] text-muted-foreground leading-normal">
            Your email has been verified. You can now sign in to your account.
          </p>
        </div>
        <div className="pt-2">
          <Link
            href="/login"
            className="inline-flex items-center justify-center min-h-[44px] w-full rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold px-6 transition-colors"
          >
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  if (resendSent) {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <h2 className="text-[20px] font-semibold text-foreground">
            Check your inbox
          </h2>
          <p className="text-[14px] text-muted-foreground leading-normal">
            If your account needs verification, an email is on the way.
          </p>
        </div>
        <div className="pt-2">
          <Link
            href="/login"
            className="inline-flex items-center justify-center min-h-[44px] w-full rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold px-6 transition-colors"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {status === 'error' && (
        <div className="space-y-2 pb-2">
          <h2 className="text-[20px] font-semibold text-foreground">
            Verification failed
          </h2>
          <p className="text-[14px] text-muted-foreground leading-normal">
            This link may have expired. Request a new one below.
          </p>
        </div>
      )}

      <form onSubmit={handleResendSubmit} className="space-y-4">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="resend-email"
            className="text-[14px] font-medium text-foreground"
          >
            Email
          </label>
          <input
            id="resend-email"
            name="email"
            type="email"
            autoComplete="email"
            value={resendEmail}
            onChange={(e) => {
              setResendEmail(e.target.value);
              if (resendError) setResendError(null);
            }}
            aria-invalid={!!resendError}
            aria-describedby={resendError ? 'resend-email-error' : undefined}
            className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-medium text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
          />
          {resendError && (
            <p id="resend-email-error" role="alert" className="text-[13px] text-down">
              {resendError}
            </p>
          )}
        </div>

        <div className="my-2">
          <TurnstileWidget onToken={setTurnstileToken} />
        </div>

        <button
          type="submit"
          disabled={!turnstileToken || isResending}
          className="w-full min-h-[44px] rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold px-6 transition-colors disabled:opacity-50 cursor-pointer"
        >
          {isResending ? 'Sending...' : 'Send verification email'}
        </button>

        <p className="mt-4 text-center text-[13px] text-muted-foreground">
          <Link
            href="/login"
            className="text-muted-foreground hover:text-foreground transition-colors font-medium"
          >
            Back to sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
