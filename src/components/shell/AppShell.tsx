'use client';

import React from 'react';
import Link from 'next/link';
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
        <Link
          href="/dashboard"
          className="inline-flex min-h-[44px] items-center font-sans text-lg font-semibold tracking-[-0.01em] text-foreground select-none"
        >
          CryptoWithAlgo
        </Link>
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
