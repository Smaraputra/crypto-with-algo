import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AuthShell, ResetPasswordForm } from '@/components/auth-v2';

export const metadata: Metadata = {
  title: 'Choose a new password | CryptoWithAlgo',
  description: 'Set a new password for your CryptoWithAlgo account.',
};

export default function ResetPasswordPage() {
  return (
    <AuthShell title="Choose a new password">
      <Suspense fallback={<div className="h-64 w-full rounded-[12px] bg-muted/40 animate-pulse" />}>
        <ResetPasswordForm />
      </Suspense>
    </AuthShell>
  );
}
