import { redirect } from 'next/navigation';

import { requireAdmin } from '@/lib/admin-auth';
import { PaperDeskDashboard } from '@/components/admin/paper-desk/PaperDeskDashboard';

export const metadata = {
  title: 'Paper Desk | Admin',
  description: 'What the composite rule has actually done forward, per style and interval',
};

export default async function PaperDeskPage() {
  // Admin-only: the desk is global, like the outcome record beside it.
  const admin = await requireAdmin();
  if (!admin.ok) {
    redirect('/dashboard');
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-6">
        <h1 className="mb-2 text-3xl font-bold">Paper Desk</h1>
        <p className="text-muted-foreground">
          The composite&apos;s own rule, traded forward on paper, one book per style and interval and never
          pooled. Each trade is booked twice: the engine price, which is what the backtest books and so is
          comparable with the research record, and the executable price a live order would have got. The gap
          between them is the lag cost no research run has measured.
        </p>
      </div>

      <PaperDeskDashboard />
    </div>
  );
}
