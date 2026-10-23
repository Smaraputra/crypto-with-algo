import React from 'react';
import type { Metadata } from 'next';
import { AuthShell, ForgotPasswordForm } from '@/components/auth-v2';

export const metadata: Metadata = {
  title: 'Reset password | CryptoWithAlgo',
  description: 'Request a password reset link for your CryptoWithAlgo account.',
};

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      title="Reset password"
      description="Enter your account email to receive a password reset link."
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}
