'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { Menu, X } from 'lucide-react';
import { BrandMark } from '@/components/kit';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { cn } from '@/lib/utils';

export function MarketingNav() {
  const { status } = useSession();
  const [isOpen, setIsOpen] = useState(false);
  const toggleButtonRef = useRef<HTMLButtonElement>(null);

  const closeMenu = () => {
    setIsOpen(false);
    toggleButtonRef.current?.focus();
  };

  const handleToggle = () => {
    if (isOpen) {
      closeMenu();
    } else {
      setIsOpen(true);
    }
  };

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-line bg-background">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-8">
          <BrandMark size="md" href="/" />
          <nav aria-label="Main" className="hidden md:flex md:items-center md:gap-6">
            <Link
              href="/features"
              className="inline-flex items-center min-h-[44px] text-[14px] font-medium text-ink-2 transition-colors hover:text-foreground"
            >
              Features
            </Link>
            <Link
              href="/how-it-works"
              className="inline-flex items-center min-h-[44px] text-[14px] font-medium text-ink-2 transition-colors hover:text-foreground"
            >
              How it works
            </Link>
            <Link
              href="/docs"
              className="inline-flex items-center min-h-[44px] text-[14px] font-medium text-ink-2 transition-colors hover:text-foreground"
            >
              Docs
            </Link>
            <Link
              href="/blog"
              className="inline-flex items-center min-h-[44px] text-[14px] font-medium text-ink-2 transition-colors hover:text-foreground"
            >
              Blog
            </Link>
          </nav>
        </div>

        <div className="hidden md:flex md:items-center md:gap-4">
          <ThemeToggle />
          {status === 'authenticated' ? (
            <Link
              href="/dashboard"
              className="inline-flex items-center min-h-[44px] rounded-full bg-brand px-4 py-2 text-[14px] font-semibold text-brand-foreground transition-opacity hover:opacity-90"
            >
              Open dashboard
            </Link>
          ) : (
            // While the session loads the signed-out actions hold their space unseen,
            // so a signed-in visitor never sees them flash.
            <div
              className={cn('flex items-center gap-4', status === 'loading' && 'invisible')}
              aria-hidden={status === 'loading' || undefined}
              inert={status === 'loading' || undefined}
            >
              <Link
                href="/login"
                className="inline-flex items-center min-h-[44px] px-3 py-2 text-[14px] font-medium text-foreground transition-colors hover:text-foreground/80"
              >
                Log in
              </Link>
              <Link
                href="/register"
                className="inline-flex items-center min-h-[44px] rounded-full bg-brand px-4 py-2 text-[14px] font-semibold text-brand-foreground transition-opacity hover:opacity-90"
              >
                Create a free account
              </Link>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 md:hidden">
          <ThemeToggle />
          <button
            ref={toggleButtonRef}
            type="button"
            aria-label="Toggle menu"
            aria-expanded={isOpen}
            onClick={handleToggle}
            className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-edge text-foreground transition-colors hover:bg-card"
          >
            {isOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {isOpen && (
        <div
          role="menu"
          aria-label="Navigation menu"
          className="border-b border-line bg-background px-4 py-5 md:hidden"
        >
          <div className="flex flex-col gap-3">
            <Link
              role="menuitem"
              href="/features"
              onClick={closeMenu}
              className="inline-flex items-center min-h-[44px] px-3 py-2 text-[15px] font-medium text-ink-2 transition-colors hover:text-foreground"
            >
              Features
            </Link>
            <Link
              role="menuitem"
              href="/how-it-works"
              onClick={closeMenu}
              className="inline-flex items-center min-h-[44px] px-3 py-2 text-[15px] font-medium text-ink-2 transition-colors hover:text-foreground"
            >
              How it works
            </Link>
            <Link
              role="menuitem"
              href="/docs"
              onClick={closeMenu}
              className="inline-flex items-center min-h-[44px] px-3 py-2 text-[15px] font-medium text-ink-2 transition-colors hover:text-foreground"
            >
              Docs
            </Link>
            <Link
              role="menuitem"
              href="/blog"
              onClick={closeMenu}
              className="inline-flex items-center min-h-[44px] px-3 py-2 text-[15px] font-medium text-ink-2 transition-colors hover:text-foreground"
            >
              Blog
            </Link>
            <div className="my-1 border-t border-line" />
            {status === 'authenticated' ? (
              <Link
                role="menuitem"
                href="/dashboard"
                onClick={closeMenu}
                className="inline-flex items-center justify-center min-h-[44px] rounded-full bg-brand px-4 py-2.5 text-[15px] font-semibold text-brand-foreground transition-opacity hover:opacity-90"
              >
                Open dashboard
              </Link>
            ) : (
              <>
                <Link
                  role="menuitem"
                  href="/login"
                  onClick={closeMenu}
                  className="inline-flex items-center min-h-[44px] px-3 py-2 text-[15px] font-medium text-foreground transition-colors hover:text-foreground/80"
                >
                  Log in
                </Link>
                <Link
                  role="menuitem"
                  href="/register"
                  onClick={closeMenu}
                  className="inline-flex items-center justify-center min-h-[44px] rounded-full bg-brand px-4 py-2.5 text-[15px] font-semibold text-brand-foreground transition-opacity hover:opacity-90"
                >
                  Create a free account
                </Link>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
