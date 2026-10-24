'use client';

import React from 'react';
import { BrandMark } from '@/components/kit';
import { TopBar } from './TopBar';
import { BottomNav } from './BottomNav';
import { CoinSearch } from './CoinSearch';
import { AlertsBell } from './AlertsBell';

export function AppShell() {
  return (
    <>
      {/* Desktop Top Bar */}
      <TopBar />

      {/* Phone Top Strip */}
      <header className="sticky top-[env(safe-area-inset-top,0px)] z-40 flex h-14 w-full items-center justify-between border-b border-line bg-background px-4 lg:hidden">
        <BrandMark size="sm" href="/dashboard" />
        <div className="flex items-center gap-1">
          <CoinSearch variant="icon" />
          <AlertsBell />
        </div>
      </header>

      {/* Phone Bottom Navigation */}
      <BottomNav />
    </>
  );
}
