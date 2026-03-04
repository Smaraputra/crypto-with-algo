import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { Sidebar } from '@/components/layout/Sidebar';
import { Header } from '@/components/layout/Header';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();

  if (session?.user && !session.user.tosAccepted) {
    redirect('/consent');
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header />
        <main id="main-content" className="flex-1 overflow-auto p-4">{children}</main>
      </div>
    </div>
  );
}
