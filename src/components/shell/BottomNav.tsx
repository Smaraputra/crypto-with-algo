'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  PHONE_NAV_ITEMS,
  MORE_SHEET_ITEMS,
  ADMIN_NAV_ITEMS,
  isNavActive,
} from './nav-items';
import { MoreSheet } from './MoreSheet';
import { cn } from '@/lib/utils';

export function BottomNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  const isMoreActive =
    moreOpen ||
    MORE_SHEET_ITEMS.some((item) => isNavActive(pathname, item)) ||
    ADMIN_NAV_ITEMS.some((item) => isNavActive(pathname, item));

  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 grid h-[calc(72px+env(safe-area-inset-bottom,0px))] grid-cols-5 border-t border-line bg-background pb-[env(safe-area-inset-bottom,0px)] lg:hidden"
      >
        {PHONE_NAV_ITEMS.map((item) => {
          const active = isNavActive(pathname, item);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative flex h-full flex-col items-center justify-center text-xs font-semibold select-none',
                'transition-colors duration-120 active:scale-[0.98] motion-reduce:active:scale-100',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                active ? 'text-foreground' : 'text-ink-2 hover:text-foreground'
              )}
            >
              {active && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0 inset-x-[22%] h-[3px] bg-brand-line"
                />
              )}
              <span>{item.label}</span>
            </Link>
          );
        })}

        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          aria-current={isMoreActive ? 'page' : undefined}
          className={cn(
            'relative flex h-full flex-col items-center justify-center text-xs font-semibold select-none cursor-pointer',
            'transition-colors duration-120 active:scale-[0.98] motion-reduce:active:scale-100',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            isMoreActive ? 'text-foreground' : 'text-ink-2 hover:text-foreground'
          )}
        >
          {isMoreActive && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-0 inset-x-[22%] h-[3px] bg-brand-line"
            />
          )}
          <span>More</span>
        </button>
      </nav>

      <MoreSheet open={moreOpen} onOpenChange={setMoreOpen} />
    </>
  );
}
