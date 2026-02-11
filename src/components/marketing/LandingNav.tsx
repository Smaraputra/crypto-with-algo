'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { Zap, Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function LandingNav() {
  const { data: session } = useSession();
  const isAuthenticated = !!session?.user;
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    toggleRef.current?.focus();
  }, []);

  // Escape key closes mobile menu
  useEffect(() => {
    if (!menuOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeMenu();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [menuOpen, closeMenu]);

  // Focus trap within mobile menu
  useEffect(() => {
    if (!menuOpen || !menuRef.current) return;
    const menu = menuRef.current;
    const focusable = menu.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first.focus();

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    menu.addEventListener('keydown', handleTab);
    return () => menu.removeEventListener('keydown', handleTab);
  }, [menuOpen]);

  return (
    <header className="fixed top-0 left-0 right-0 z-50 px-4 pt-4">
      <nav
        className={cn(
          'mx-auto flex h-14 max-w-5xl items-center justify-between rounded-full border px-4 transition-all duration-300',
          scrolled
            ? 'border-border/50 bg-background/90 backdrop-blur-md shadow-lg shadow-black/20'
            : 'border-border/30 bg-background/60 backdrop-blur-sm'
        )}
      >
        <Link href="/" className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-primary" />
          <span className="text-sm font-semibold tracking-tight">
            AlgoCrypto
          </span>
        </Link>

        {/* Center links - desktop only */}
        <div className="hidden items-center gap-6 sm:flex">
          <Link
            href="/features"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Features
          </Link>
          <Link
            href="/how-it-works"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            How It Works
          </Link>
          <Link
            href="/docs"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Docs
          </Link>
          <Link
            href="/blog"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Blog
          </Link>
        </div>

        {/* Right side - desktop */}
        <div className="hidden items-center gap-3 sm:flex">
          {isAuthenticated ? (
            <Button size="sm" className="rounded-full" asChild>
              <Link href="/dashboard">Dashboard</Link>
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" className="rounded-full" asChild>
                <Link href="/login">Sign In</Link>
              </Button>
              <Button size="sm" className="rounded-full" asChild>
                <Link href="/register">Get Started</Link>
              </Button>
            </>
          )}
        </div>

        {/* Mobile toggle */}
        <Button
          ref={toggleRef}
          variant="ghost"
          size="icon"
          className="sm:hidden"
          onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
          aria-label="Toggle menu"
          aria-expanded={menuOpen}
        >
          {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </Button>
      </nav>

      {/* Mobile menu */}
      {menuOpen && (
        <div
          ref={menuRef}
          role="menu"
          className="mx-auto mt-2 max-w-5xl rounded-2xl border border-border/50 bg-background/95 px-4 py-4 backdrop-blur-md sm:hidden"
        >
          <div className="flex flex-col gap-2">
            <Link
              href="/features"
              role="menuitem"
              className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
              onClick={closeMenu}
            >
              Features
            </Link>
            <Link
              href="/how-it-works"
              role="menuitem"
              className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
              onClick={closeMenu}
            >
              How It Works
            </Link>
            <Link
              href="/docs"
              role="menuitem"
              className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
              onClick={closeMenu}
            >
              Docs
            </Link>
            <Link
              href="/blog"
              role="menuitem"
              className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
              onClick={closeMenu}
            >
              Blog
            </Link>
            <div className="my-1 h-px bg-border/50" />
            {isAuthenticated ? (
              <Button size="sm" className="rounded-full" asChild>
                <Link href="/dashboard" role="menuitem" onClick={closeMenu}>
                  Dashboard
                </Link>
              </Button>
            ) : (
              <>
                <Button variant="ghost" size="sm" asChild>
                  <Link href="/login" role="menuitem" onClick={closeMenu}>
                    Sign In
                  </Link>
                </Button>
                <Button size="sm" className="rounded-full" asChild>
                  <Link href="/register" role="menuitem" onClick={closeMenu}>
                    Get Started
                  </Link>
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
