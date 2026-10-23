import React from 'react';
import Link from 'next/link';

export interface AuthShellProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

export function AuthShell({ title, description, children }: AuthShellProps) {
  return (
    <div className="w-full max-w-[420px] mx-auto px-4 py-8 flex flex-col">
      <div className="flex items-center justify-between pb-8">
        <Link
          href="/"
          className="text-[18px] font-semibold text-foreground tracking-tight hover:opacity-85 transition-opacity"
        >
          CryptoWithAlgo
        </Link>
        <Link
          href="/"
          className="text-[13px] text-muted-foreground hover:text-foreground transition-colors"
        >
          Back to home
        </Link>
      </div>
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
    </div>
  );
}
