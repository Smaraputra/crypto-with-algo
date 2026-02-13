import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { OptimizationDashboard } from '@/components/admin/optimization/OptimizationDashboard';

export const metadata = {
  title: 'Template Optimization | Admin',
  description: 'Optimize signal template weights using walk-forward analysis',
};

export default async function OptimizationPage() {
  const session = await auth();

  // Admin-only page
  if (!session?.user?.email || session.user.email !== process.env.ADMIN_EMAIL) {
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
