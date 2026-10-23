'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { isNavActive, TOOLS_NAV_ITEMS, TOOLS_INTERIM_ITEMS } from './nav-items';
import { cn } from '@/lib/utils';

export function ToolsMenu() {
  const pathname = usePathname();
  const active = isNavActive(pathname, 'Tools');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-active={active ? 'true' : undefined}
          className={cn(
            'relative inline-flex min-h-[44px] items-center px-3 xl:px-3.5 font-semibold whitespace-nowrap transition-colors duration-120 select-none rounded-[10px]',
            'active:scale-[0.98] motion-reduce:active:scale-100',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            'text-ink-2 hover:bg-muted hover:text-foreground data-[active]:text-foreground'
          )}
        >
          <span>Tools</span>
          {active && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-x-3 xl:inset-x-3.5 bottom-1 h-[3px] rounded-xs bg-brand-line"
            />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48 p-1.5 shadow-md">
        {TOOLS_NAV_ITEMS.map((item) => {
          const itemActive = isNavActive(pathname, item);
          return (
            <DropdownMenuItem key={item.href} asChild>
              <Link
                href={item.href}
                aria-current={itemActive ? 'page' : undefined}
                className="flex min-h-[44px] cursor-pointer items-center px-3 py-2 font-medium"
              >
                {item.label}
              </Link>
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator className="my-1 border-line" />
        {TOOLS_INTERIM_ITEMS.map((item) => {
          const itemActive = isNavActive(pathname, item);
          return (
            <DropdownMenuItem key={item.href} asChild>
              <Link
                href={item.href}
                aria-current={itemActive ? 'page' : undefined}
                className="flex min-h-[44px] cursor-pointer items-center px-3 py-2 font-medium text-ink-2"
              >
                {item.label}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
