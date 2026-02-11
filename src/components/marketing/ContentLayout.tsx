import { LandingNav } from './LandingNav';
import { Footer } from './Footer';

interface ContentLayoutProps {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}

export function ContentLayout({ title, subtitle, children }: ContentLayoutProps) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <LandingNav />
      <main id="main-content" className="pt-28 pb-16 sm:pt-36 sm:pb-24">
        <div className="mx-auto max-w-4xl px-4">
          <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
            <span className="gradient-heading">{title}</span>
          </h1>
          <p className="mt-3 text-lg text-muted-foreground">{subtitle}</p>
          <div className="gradient-separator mt-6" />
          <div className="mt-10">{children}</div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
