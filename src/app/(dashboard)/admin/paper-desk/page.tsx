import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/admin-auth';
import { PaperDeskScreen } from '@/components/admin-v2';

export const metadata: Metadata = {
  title: 'Paper desk | CryptoWithAlgo',
};

export default async function PaperDeskPage() {
  const admin = await requireAdmin();
  if (!admin.ok) {
    redirect('/dashboard');
  }

  return <PaperDeskScreen />;
}
