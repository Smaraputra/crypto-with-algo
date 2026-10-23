import React from 'react';

export interface LegalPageProps {
  title: string;
  lastUpdated: string;
  children: React.ReactNode;
}

export function LegalPage({ title, lastUpdated, children }: LegalPageProps) {
  return (
    <div className="mx-auto max-w-[68ch] px-4 py-12 sm:px-6 sm:py-16">
      <header className="mb-8 border-b border-line pb-6">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          {title}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Last updated: {lastUpdated}
        </p>
      </header>

      <div className="space-y-6 text-ink-2 leading-relaxed [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-foreground [&_h2]:mt-8 [&_h2]:mb-3 [&_h3]:text-base [&_h3]:font-medium [&_h3]:text-foreground [&_h3]:mt-6 [&_h3]:mb-2 [&_p]:text-[15px] [&_p]:leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1.5 [&_li]:text-[15px] [&_strong]:text-foreground [&_a]:text-brand-line [&_a]:underline">
        {children}
      </div>
    </div>
  );
}
