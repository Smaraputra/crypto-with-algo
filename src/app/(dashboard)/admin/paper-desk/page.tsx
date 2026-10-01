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
          between them is the lag cost no research run has measured. Each book is read by a rule declared on
          2026-10-02, before its first trade: it closes as soon as the executable interval sits below zero, and
          it is read for going live only once, at a trade count sized from the recorded evidence, which at 1h
          is years of trading. The research record says this rule loses after costs. The desk measures how it
          executes, not whether it has an edge.
        </p>
      </div>

      <PaperDeskDashboard />
    </div>
  );
}
