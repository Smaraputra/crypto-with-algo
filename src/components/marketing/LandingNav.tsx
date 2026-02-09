'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Star, Menu, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <header
      className={cn(
        'fixed top-0 left-0 right-0 z-50 transition-all duration-300',
        scrolled
          ? 'bg-background/95 backdrop-blur-sm border-b border-border'
          : 'bg-transparent'
      )}
    >
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2">
          <Star className="h-5 w-5 text-accent" />
          <span className="text-sm font-semibold tracking-tight">
            Crypto Portfolio Tracker
          </span>
        </Link>

        {/* Desktop */}
        <div className="hidden items-center gap-3 sm:flex">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/login">Sign In</Link>
          </Button>
          <Button size="sm" asChild>
            <Link href="/register">Get Started</Link>
          </Button>
        </div>

        {/* Mobile toggle */}
        <Button
          variant="ghost"
          size="icon"
          className="sm:hidden"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Toggle menu"
        >
          {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </Button>
      </nav>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="border-b border-border bg-background px-4 pb-4 sm:hidden">
          <div className="flex flex-col gap-2">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/login" onClick={() => setMenuOpen(false)}>
                Sign In
              </Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/register" onClick={() => setMenuOpen(false)}>
                Get Started
              </Link>
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
