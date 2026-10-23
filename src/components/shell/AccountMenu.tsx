'use client';

import React from 'react';
import Link from 'next/link';
import { useSession, signOut } from 'next-auth/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { ADMIN_NAV_ITEMS } from './nav-items';
import { cn } from '@/lib/utils';

export function AccountMenu() {
  const { data: session } = useSession();
  const isAdmin = session?.user?.isAdmin === true;
  const email = session?.user?.email;

  const handleSignOut = () => {
    signOut({ callbackUrl: '/login' });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex min-h-[44px] items-center px-3.5 font-semibold text-ink-2 transition-colors duration-120 select-none rounded-[10px]',
            'hover:bg-muted hover:text-foreground active:scale-[0.98] motion-reduce:active:scale-100',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
          )}
        >
          <span>Account</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 p-1.5 shadow-md">
        {email && (
          <DropdownMenuLabel className="truncate px-3 py-1.5 text-xs font-normal text-muted-foreground">
            {email}
          </DropdownMenuLabel>
        )}
        <div className="flex items-center px-3 py-1.5">
          <ThemeToggle />
        </div>
        <DropdownMenuSeparator className="my-1 border-line" />

        {isAdmin && (
          <>
            {ADMIN_NAV_ITEMS.map((item) => (
              <DropdownMenuItem key={item.href} asChild>
                <Link
                  href={item.href}
                  className="flex min-h-[44px] cursor-pointer items-center px-3 py-2 font-medium"
                >
                  {item.label}
                </Link>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator className="my-1 border-line" />
          </>
        )}

        <DropdownMenuItem asChild>
          <Link
            href="/privacy"
            className="flex min-h-[44px] cursor-pointer items-center px-3 py-2 font-medium"
          >
            Privacy
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link
            href="/terms"
            className="flex min-h-[44px] cursor-pointer items-center px-3 py-2 font-medium"
          >
            Terms
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator className="my-1 border-line" />
        <DropdownMenuItem
          onSelect={handleSignOut}
          className="flex min-h-[44px] cursor-pointer items-center px-3 py-2 font-medium text-destructive focus:text-destructive"
        >
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
