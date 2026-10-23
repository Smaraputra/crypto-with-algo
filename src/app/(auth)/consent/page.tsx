import React from 'react';
import type { Metadata } from 'next';
import { AuthShell, ConsentForm } from '@/components/auth-v2';

export const metadata: Metadata = {
  title: 'Terms | CryptoWithAlgo',
  description: 'Review and accept terms to continue to CryptoWithAlgo.',
};

export default function ConsentPage() {
  return (
    <AuthShell title="Terms">
      <ConsentForm />
    </AuthShell>
  );
}
