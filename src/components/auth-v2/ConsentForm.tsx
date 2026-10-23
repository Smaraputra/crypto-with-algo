'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { recordConsent } from '@/lib/auth-forms/flows';

export interface ConsentFormProps {
  title?: string | null;
}

export function ConsentForm({ title = 'Accept the terms to continue' }: ConsentFormProps) {
  const router = useRouter();
  const session = useSession();
  const update = session?.update;

  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agreed || isSubmitting) return;

    setError(null);
    setIsSubmitting(true);

    try {
      const res = await recordConsent();
      if (!res.ok) {
        setError(res.message);
        return;
      }

      await update?.({ tosAccepted: true });
      router.push('/dashboard');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {title && (
        <h2 className="text-[20px] font-semibold text-foreground">
          {title}
        </h2>
      )}

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="consent-terms"
          className="flex items-center gap-3 min-h-[44px] cursor-pointer"
        >
          <input
            id="consent-terms"
            name="tosAccepted"
            type="checkbox"
            checked={agreed}
            onChange={(e) => {
              setAgreed(e.target.checked);
              if (error) setError(null);
            }}
            className="size-4 rounded-[4px] border-edge text-brand focus:ring-ring cursor-pointer"
          />
          <span className="text-[14px] text-foreground select-none font-medium">
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
      </div>

      {error && (
        <p role="alert" className="text-[13px] text-down">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={!agreed || isSubmitting}
        className="w-full min-h-[44px] rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold px-6 transition-colors disabled:opacity-50 cursor-pointer"
      >
        {isSubmitting ? 'Continuing...' : 'Continue'}
      </button>
    </form>
  );
}
