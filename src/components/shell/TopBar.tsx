'use client';

import React from 'react';
import { BrandMark } from '@/components/kit';
import { NavLink } from './NavLink';
import { ToolsMenu } from './ToolsMenu';
import { CoinSearch } from './CoinSearch';
import { AlertsBell } from './AlertsBell';
import { AccountMenu } from './AccountMenu';
import { PRIMARY_NAV_ITEMS } from './nav-items';

export function TopBar() {
  return (
    <header className="sticky top-[env(safe-area-inset-top,0px)] z-40 hidden w-full border-b border-line bg-background lg:block">
      <div className="mx-auto flex h-16 w-full max-w-[1240px] items-center justify-between px-4 sm:px-6">
        {/* Left */}
        <div className="flex min-w-0 items-center gap-4 xl:gap-6">
          <BrandMark size="md" href="/dashboard" className="text-[22px]" />
          <nav className="flex items-center gap-1 whitespace-nowrap" aria-label="Desktop primary">
            {PRIMARY_NAV_ITEMS.map((item) => (
              <NavLink key={item.href} item={item} />
            ))}
            <ToolsMenu />
          </nav>
        </div>

        {/* Right */}
        <div className="flex items-center gap-3">
          <CoinSearch variant="desktop" />
          <AlertsBell />
          <AccountMenu />
        </div>
      </div>
    </header>
  );
}
