import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { AppShell } from '@/components/shell';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (session?.user && !session.user.tosAccepted) {
    redirect('/consent');
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <AppShell />
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-[1240px] px-4 sm:px-6 pb-28 lg:pb-12 pt-6 outline-none"
      >
        {children}
      </main>
    </div>
  );
}
