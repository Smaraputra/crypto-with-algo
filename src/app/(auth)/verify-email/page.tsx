import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AuthShell, VerifyEmail } from '@/components/auth-v2';

export const metadata: Metadata = {
  title: 'Verify email | CryptoWithAlgo',
  description: 'Verify your email address to activate your CryptoWithAlgo account.',
};

export default function VerifyEmailPage() {
  return (
    <AuthShell title="Verify email">
      <Suspense fallback={<div className="h-64 w-full rounded-[12px] bg-muted/40 animate-pulse" />}>
        <VerifyEmail />
      </Suspense>
    </AuthShell>
  );
}
