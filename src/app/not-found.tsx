import type { Metadata } from 'next';
import Link from 'next/link';
import { BrandMark } from '@/components/kit';

export const metadata: Metadata = {
  title: 'Page not found | CryptoWithAlgo',
};

export default function NotFound() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4 py-16 bg-background text-foreground">
      <div className="w-full max-w-md flex flex-col items-center text-center">
        <BrandMark size="md" href="/" className="mb-8" />
        <h1 className="text-[32px] sm:text-[36px] font-semibold text-foreground tracking-[-0.01em] leading-tight mb-3">
          Page not found
        </h1>
        <p className="text-[15px] text-muted-foreground leading-relaxed mb-8 max-w-[38ch]">
          The address may be mistyped, or the page has moved.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 w-full">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-full bg-brand px-6 min-h-[44px] text-[15px] font-semibold text-brand-foreground hover:bg-brand/90 transition-colors w-full sm:w-auto"
          >
            Go to the home page
          </Link>
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center rounded-[12px] border border-border bg-card px-6 min-h-[44px] text-[15px] font-semibold text-foreground hover:bg-muted transition-colors w-full sm:w-auto"
          >
            Open the app
          </Link>
        </div>
      </div>
    </main>
  );
}
