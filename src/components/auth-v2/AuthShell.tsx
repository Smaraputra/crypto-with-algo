import React from 'react';
import Link from 'next/link';
import { BrandMark } from '@/components/kit';

export interface AuthShellProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

export function AuthShell({ title, description, children }: AuthShellProps) {
  return (
    <div className="w-full max-w-[420px] mx-auto px-4 py-8 flex flex-col">
      <header className="flex items-center justify-between pb-8">
        <BrandMark size="md" href="/" />
        <Link
          href="/"
          className="inline-flex items-center min-h-[44px] text-[13px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Back to home
        </Link>
      </header>
      <main id="main-content">
        <div className="space-y-1.5 mb-6">
          <h1 className="text-[26px] font-semibold text-foreground tracking-tight">
            {title}
          </h1>
          {description && (
            <p className="text-[14px] text-muted-foreground leading-normal">
              {description}
            </p>
          )}
        </div>
        <div>{children}</div>
      </main>
    </div>
  );
}
