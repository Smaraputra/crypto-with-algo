'use client';

import React from 'react';
import Link from 'next/link';
import { useSession, signOut } from 'next-auth/react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { MORE_SHEET_ITEMS, ADMIN_NAV_ITEMS } from './nav-items';
import { cn } from '@/lib/utils';

export interface MoreSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MoreSheet({ open, onOpenChange }: MoreSheetProps) {
  const { data: session } = useSession();
  const isAdmin = session?.user?.isAdmin === true;

  const handleLinkClick = () => {
    onOpenChange(false);
  };

  const handleSignOut = () => {
    onOpenChange(false);
    signOut({ callbackUrl: '/login' });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[85vh] overflow-y-auto rounded-t-[22px] border-t border-line bg-background p-6"
      >
        <SheetHeader className="mb-4 p-0">
          <SheetTitle className="font-semibold text-lg text-foreground">More</SheetTitle>
          <SheetDescription className="sr-only">More navigation options and settings</SheetDescription>
        </SheetHeader>

        <nav className="flex flex-col gap-1" aria-label="More navigation">
          {MORE_SHEET_ITEMS.map((item) => (
            <Link
              key={item.href + item.label}
              href={item.href}
              onClick={handleLinkClick}
              className={cn(
                'flex min-h-[44px] items-center rounded-lg px-3 text-base font-semibold text-ink-2 select-none',
                'transition-colors duration-120 hover:bg-muted hover:text-foreground active:scale-[0.98] motion-reduce:active:scale-100',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
              )}
            >
              {item.label}
            </Link>
          ))}

          {isAdmin && (
            <div className="my-2 border-t border-line pt-2">
              <span className="px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Admin
              </span>
              {ADMIN_NAV_ITEMS.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={handleLinkClick}
                  className={cn(
                    'flex min-h-[44px] items-center rounded-lg px-3 text-base font-semibold text-ink-2 select-none',
                    'transition-colors duration-120 hover:bg-muted hover:text-foreground active:scale-[0.98] motion-reduce:active:scale-100',
                    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          )}

          <div className="my-2 border-t border-line pt-2">
            <div className="flex min-h-[44px] items-center px-3">
              <ThemeToggle />
            </div>
          </div>

          <div className="my-2 border-t border-line pt-2">
            <Link
              href="/privacy"
              onClick={handleLinkClick}
              className={cn(
                'flex min-h-[44px] items-center rounded-lg px-3 text-base font-semibold text-ink-2 select-none',
                'transition-colors duration-120 hover:bg-muted hover:text-foreground active:scale-[0.98] motion-reduce:active:scale-100',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
              )}
            >
              Privacy
            </Link>
            <Link
              href="/terms"
              onClick={handleLinkClick}
              className={cn(
                'flex min-h-[44px] items-center rounded-lg px-3 text-base font-semibold text-ink-2 select-none',
                'transition-colors duration-120 hover:bg-muted hover:text-foreground active:scale-[0.98] motion-reduce:active:scale-100',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
              )}
            >
              Terms
            </Link>
          </div>

          <div className="my-2 border-t border-line pt-2">
            <button
              type="button"
              onClick={handleSignOut}
              className={cn(
                'flex min-h-[44px] w-full items-center rounded-lg px-3 text-left text-base font-semibold text-destructive select-none',
                'transition-colors duration-120 hover:bg-muted active:scale-[0.98] motion-reduce:active:scale-100',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
              )}
            >
              Log out
            </button>
          </div>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
