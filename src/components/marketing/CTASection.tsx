import Link from 'next/link';
import { Button } from '@/components/ui/button';

export function CTASection() {
  return (
    <section className="border-t border-border py-16 sm:py-24">
      <div className="mx-auto max-w-2xl px-4 text-center">
        <div className="rounded-lg border border-accent/30 bg-card p-8 sm:p-12">
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
            Start Tracking Today
          </h2>
          <p className="mt-3 text-muted-foreground">
            Create your free account and connect to live market data in seconds.
          </p>
          <div className="mt-6">
            <Button size="lg" asChild>
              <Link href="/register">Create Free Account</Link>
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}
