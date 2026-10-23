'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

export interface AdminTabsProps {
  currentPath?: string;
  className?: string;
}

const TABS = [
  { href: '/admin/calibration', label: 'Calibration' },
  { href: '/admin/paper-desk', label: 'Paper desk' },
] as const;

export const AdminTabs: React.FC<AdminTabsProps> = ({ currentPath, className }) => {
  const pathname = usePathname();
  const activePath = currentPath ?? pathname;

  return (
    <nav
      aria-label="Admin sections"
      className={cn('flex items-center gap-2 p-1 bg-muted/40 rounded-[14px] w-fit', className)}
    >
      {TABS.map((tab) => {
        const isActive = activePath === tab.href || (activePath ? activePath.startsWith(`${tab.href}/`) : false);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'min-h-[44px] px-4 py-2 inline-flex items-center justify-center rounded-[12px] text-[14px] font-semibold transition-colors',
              isActive
                ? 'bg-foreground text-background shadow-none'
                : 'text-muted-foreground hover:text-foreground bg-transparent'
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
};
