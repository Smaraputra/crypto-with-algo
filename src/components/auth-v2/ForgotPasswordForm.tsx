'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { TurnstileWidget } from '@/components/auth/turnstile';
import { requestPasswordReset } from '@/lib/auth-forms/flows';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email || !email.includes('@')) {
      setEmailError('Invalid email address');
      return;
    }

    setEmailError(null);
    setIsSubmitting(true);

    try {
      await requestPasswordReset({ email, turnstileToken });
    } catch {
      // Swallowed: neutral confirmation is shown regardless
    } finally {
      setIsSubmitting(false);
      setIsSubmitted(true);
    }
  };

  if (isSubmitted) {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <h2 className="text-[20px] font-semibold text-foreground">
            Check your inbox
          </h2>
          <p className="text-[14px] text-muted-foreground leading-normal">
            If an account exists with that email, a password reset link is on the way.
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
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="forgot-email"
          className="text-[14px] font-medium text-foreground"
        >
          Email
        </label>
        <input
          id="forgot-email"
          name="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (emailError) setEmailError(null);
          }}
          aria-invalid={!!emailError}
          aria-describedby={emailError ? 'forgot-email-error' : undefined}
          className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-medium text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
        />
        {emailError && (
          <p id="forgot-email-error" role="alert" className="text-[13px] text-down">
            {emailError}
          </p>
        )}
      </div>

      <div className="my-2">
        <TurnstileWidget onToken={setTurnstileToken} />
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full min-h-[44px] rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold px-6 transition-colors disabled:opacity-50 cursor-pointer"
      >
        {isSubmitting ? 'Sending reset link...' : 'Send reset link'}
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
  );
}
