'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { signIn } from 'next-auth/react';
import { TurnstileWidget } from '@/components/auth/turnstile';
import { registerAccount } from '@/lib/auth-forms/flows';
import { registerSchema } from '@/lib/auth-forms/schemas';

export function RegisterForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [tosAccepted, setTosAccepted] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    const parsed = registerSchema.safeParse({
      name,
      email,
      password,
      confirmPassword,
      tosAccepted,
    });

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
      const res = await registerAccount({
        name,
        email,
        password,
        confirmPassword,
        tosAccepted,
        turnstileToken,
      });

      if (!res.ok) {
        setServerError(res.message);
        return;
      }

      setIsSuccess(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSuccess) {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <h2 className="text-[20px] font-semibold text-foreground">
            Check your inbox
          </h2>
          <p className="text-[14px] text-muted-foreground leading-normal">
            We sent a verification link to {email}. Open it to activate your account.
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

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-4">
        {serverError && (
          <div
            role="alert"
            className="p-3 rounded-[12px] bg-down/10 border border-down/30 text-down text-[14px] font-medium"
          >
            {serverError}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="register-name"
            className="text-[14px] font-medium text-foreground"
          >
            Name
          </label>
          <input
            id="register-name"
            name="name"
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (fieldErrors.name) setFieldErrors((prev) => ({ ...prev, name: '' }));
            }}
            aria-invalid={!!fieldErrors.name}
            aria-describedby={fieldErrors.name ? 'register-name-error' : undefined}
            className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-medium text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
          />
          {fieldErrors.name && (
            <p id="register-name-error" role="alert" className="text-[13px] text-down">
              {fieldErrors.name}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="register-email"
            className="text-[14px] font-medium text-foreground"
          >
            Email
          </label>
          <input
            id="register-email"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (fieldErrors.email) setFieldErrors((prev) => ({ ...prev, email: '' }));
            }}
            aria-invalid={!!fieldErrors.email}
            aria-describedby={fieldErrors.email ? 'register-email-error' : undefined}
            className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-medium text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
          />
          {fieldErrors.email && (
            <p id="register-email-error" role="alert" className="text-[13px] text-down">
              {fieldErrors.email}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="register-password"
            className="text-[14px] font-medium text-foreground"
          >
            Password
          </label>
          <input
            id="register-password"
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (fieldErrors.password) setFieldErrors((prev) => ({ ...prev, password: '' }));
            }}
            aria-invalid={!!fieldErrors.password}
            aria-describedby={
              fieldErrors.password
                ? 'register-password-error register-password-rule'
                : 'register-password-rule'
            }
            className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-medium text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
          />
          <p id="register-password-rule" className="text-[13px] text-muted-foreground">
            At least 8 characters, with an uppercase letter, a digit and a symbol.
          </p>
          {fieldErrors.password && (
            <p id="register-password-error" role="alert" className="text-[13px] text-down">
              {fieldErrors.password}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="register-confirm-password"
            className="text-[14px] font-medium text-foreground"
          >
            Confirm password
          </label>
          <input
            id="register-confirm-password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => {
              setConfirmPassword(e.target.value);
              if (fieldErrors.confirmPassword) {
                setFieldErrors((prev) => ({ ...prev, confirmPassword: '' }));
              }
            }}
            aria-invalid={!!fieldErrors.confirmPassword}
            aria-describedby={
              fieldErrors.confirmPassword ? 'register-confirm-password-error' : undefined
            }
            className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-medium text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
          />
          {fieldErrors.confirmPassword && (
            <p
              id="register-confirm-password-error"
              role="alert"
              className="text-[13px] text-down"
            >
              {fieldErrors.confirmPassword}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5 pt-1">
          <label
            htmlFor="register-tos"
            className="flex items-center gap-3 min-h-[44px] cursor-pointer"
          >
            <input
              id="register-tos"
              name="tosAccepted"
              type="checkbox"
              checked={tosAccepted}
              onChange={(e) => {
                setTosAccepted(e.target.checked);
                if (fieldErrors.tosAccepted) {
                  setFieldErrors((prev) => ({ ...prev, tosAccepted: '' }));
                }
              }}
              aria-invalid={!!fieldErrors.tosAccepted}
              aria-describedby={fieldErrors.tosAccepted ? 'register-tos-error' : undefined}
              className="size-4 rounded-[4px] border-edge text-brand focus:ring-ring cursor-pointer"
            />
            <span className="text-[13px] text-muted-foreground select-none">
              I accept the{' '}
              <Link
                href="/terms"
                className="text-foreground underline hover:opacity-85"
                target="_blank"
                rel="noreferrer"
              >
                Terms of Service
              </Link>{' '}
              and{' '}
              <Link
                href="/privacy"
                className="text-foreground underline hover:opacity-85"
                target="_blank"
                rel="noreferrer"
              >
                Privacy Policy
              </Link>
            </span>
          </label>
          {fieldErrors.tosAccepted && (
            <p id="register-tos-error" role="alert" className="text-[13px] text-down">
              {fieldErrors.tosAccepted}
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
          {isSubmitting ? 'Creating account...' : 'Create account'}
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
          onClick={() => signIn('google', { callbackUrl: '/dashboard' })}
          className="min-h-[44px] rounded-[12px] border border-edge bg-background hover:bg-card text-foreground font-medium px-4 text-[14px] transition-colors cursor-pointer"
        >
          Google
        </button>
        <button
          type="button"
          onClick={() => signIn('github', { callbackUrl: '/dashboard' })}
          className="min-h-[44px] rounded-[12px] border border-edge bg-background hover:bg-card text-foreground font-medium px-4 text-[14px] transition-colors cursor-pointer"
        >
          GitHub
        </button>
      </div>

      <p className="mt-6 text-center text-[13px] text-muted-foreground">
        Already have an account?{' '}
        <Link
          href="/login"
          className="text-foreground underline hover:opacity-80 font-medium"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
