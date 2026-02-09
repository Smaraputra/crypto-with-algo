import Link from 'next/link';
import { Star } from 'lucide-react';

export function Footer() {
  return (
    <footer className="border-t border-border py-8">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 sm:flex-row">
        <div className="flex items-center gap-2">
          <Star className="h-4 w-4 text-accent" />
          <span className="text-sm font-semibold">Crypto Portfolio Tracker</span>
        </div>

        <nav className="flex gap-6 text-sm text-muted-foreground">
          <Link href="/login" className="hover:text-foreground transition-colors">
            Sign In
          </Link>
          <Link href="/register" className="hover:text-foreground transition-colors">
            Register
          </Link>
        </nav>

        <p className="text-xs text-muted-foreground">
          &copy; {new Date().getFullYear()} Crypto Portfolio Tracker
        </p>
      </div>
    </footer>
  );
}
