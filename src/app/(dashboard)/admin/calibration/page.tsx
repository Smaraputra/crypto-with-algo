import { redirect } from 'next/navigation';

import { requireAdmin } from '@/lib/admin-auth';
import { CalibrationDashboard } from '@/components/admin/calibration/CalibrationDashboard';

export const metadata = {
  title: 'Signal Calibration | Admin',
  description: 'What the live signal predicted against what the market actually did',
};

export default async function CalibrationPage() {
  // Admin-only: the outcome record is global, not per-user. A misconfigured
  // ADMIN_EMAIL is logged by requireAdmin; either failure mode sends the
  // visitor back to the dashboard.
  const admin = await requireAdmin();
  if (!admin.ok) {
    redirect('/dashboard');
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="mb-2 text-3xl font-bold">Signal Calibration</h1>
        <p className="text-muted-foreground">
          Resolved outcomes of scheduler-produced signals: close-to-close forward returns over a
          fixed horizon, with no stop, no take-profit and no fill simulation. Not a backtest.
        </p>
      </div>

      <CalibrationDashboard />
    </div>
  );
}
