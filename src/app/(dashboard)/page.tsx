import { auth } from '@/lib/auth';

export default async function DashboardPage() {
  const session = await auth();

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-foreground">Dashboard</h1>
      <p className="text-sm text-muted-foreground">
        Welcome{session?.user?.name ? `, ${session.user.name}` : ''}. Market overview and trading charts coming soon.
      </p>
    </div>
  );
}
