import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AuthShell, LoginForm } from '@/components/auth-v2';

export const metadata: Metadata = {
  title: 'Sign in | CryptoWithAlgo',
  description: 'Sign in to your CryptoWithAlgo account.',
};

export default function LoginPage() {
  return (
    <AuthShell title="Sign in">
      <Suspense fallback={<div className="h-64 w-full rounded-[12px] bg-muted/40 animate-pulse" />}>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
