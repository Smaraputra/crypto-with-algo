import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/admin-auth';
import { CalibrationScreen } from '@/components/admin-v2';

export const metadata: Metadata = {
  title: 'Calibration | CryptoWithAlgo',
};

export default async function CalibrationPage() {
  const admin = await requireAdmin();
  if (!admin.ok) {
    redirect('/dashboard');
  }

  return <CalibrationScreen />;
}
