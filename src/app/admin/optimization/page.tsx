import { redirect } from 'next/navigation';
import { requireAdmin } from '@/lib/admin-auth';
import { OptimizationDashboard } from '@/components/admin/optimization/OptimizationDashboard';

export const metadata = {
  title: 'Template Optimization | Admin',
  description: 'Optimize signal template weights using walk-forward analysis',
};

export default async function OptimizationPage() {
  // Admin-only page. A misconfigured ADMIN_EMAIL is logged by requireAdmin;
  // either failure mode sends the visitor back to the dashboard.
  const admin = await requireAdmin();
  if (!admin.ok) {
    redirect('/dashboard');
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Template Optimization</h1>
        <p className="text-muted-foreground">
          Discover optimal signal template weights through walk-forward analysis on historical data
        </p>
      </div>

      <OptimizationDashboard />
    </div>
  );
}
