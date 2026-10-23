'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { resetPassword } from '@/lib/auth-forms/flows';
import { resetSchema } from '@/lib/auth-forms/schemas';

export interface ResetPasswordFormProps {
  token?: string | null;
}

export function ResetPasswordForm({ token: propToken }: ResetPasswordFormProps) {
  const searchParams = useSearchParams();
  const token = propToken ?? searchParams?.get('token');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!token) {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <h2 className="text-[20px] font-semibold text-foreground">
            Invalid reset link
          </h2>
          <p className="text-[14px] text-muted-foreground leading-normal">
            This password reset link is invalid or has expired. Request a new one to continue.
          </p>
        </div>
        <div className="pt-2">
          <Link
            href="/forgot-password"
            className="inline-flex items-center justify-center min-h-[44px] w-full rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold px-6 transition-colors"
          >
            Request a new reset link
          </Link>
        </div>
      </div>
    );
  }

  if (isSuccess) {
    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <h2 className="text-[20px] font-semibold text-foreground">
            Password reset
          </h2>
          <p className="text-[14px] text-muted-foreground leading-normal">
            Your password has been reset successfully. You can now sign in with your new password.
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    const parsed = resetSchema.safeParse({ password, confirm });
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
      const res = await resetPassword({ token, password, confirm });
      if (!res.ok) {
        setServerError(res.message);
        return;
      }
      setIsSuccess(true);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
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
          htmlFor="reset-password"
          className="text-[14px] font-medium text-foreground"
        >
          New password
        </label>
        <input
          id="reset-password"
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
              ? 'reset-password-error reset-password-rule'
              : 'reset-password-rule'
          }
          className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-medium text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
        />
        <p id="reset-password-rule" className="text-[13px] text-muted-foreground">
          At least 8 characters, with an uppercase letter, a digit and a symbol.
        </p>
        {fieldErrors.password && (
          <p id="reset-password-error" role="alert" className="text-[13px] text-down">
            {fieldErrors.password}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="reset-confirm"
          className="text-[14px] font-medium text-foreground"
        >
          Confirm password
        </label>
        <input
          id="reset-confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
            if (fieldErrors.confirm) setFieldErrors((prev) => ({ ...prev, confirm: '' }));
          }}
          aria-invalid={!!fieldErrors.confirm}
          aria-describedby={fieldErrors.confirm ? 'reset-confirm-error' : undefined}
          className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-medium text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
        />
        {fieldErrors.confirm && (
          <p id="reset-confirm-error" role="alert" className="text-[13px] text-down">
            {fieldErrors.confirm}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full min-h-[44px] rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold px-6 transition-colors disabled:opacity-50 cursor-pointer"
      >
        {isSubmitting ? 'Resetting password...' : 'Reset password'}
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
