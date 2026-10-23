import React from 'react';
import type { Metadata } from 'next';
import { AuthShell, RegisterForm } from '@/components/auth-v2';

export const metadata: Metadata = {
  title: 'Create account | CryptoWithAlgo',
  description: 'Create a new account on CryptoWithAlgo.',
};

export default function RegisterPage() {
  return (
    <AuthShell title="Create account">
      <RegisterForm />
    </AuthShell>
  );
}
