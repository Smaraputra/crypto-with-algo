import { Star } from 'lucide-react';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background">
      {/* Grid pattern overlay */}
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            'linear-gradient(var(--muted-foreground) 1px, transparent 1px), linear-gradient(90deg, var(--muted-foreground) 1px, transparent 1px)',
          backgroundSize: '40px 40px',
        }}
      />

      {/* Radial gradient glow */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 600px 400px at 50% 40%, oklch(0.72 0.18 160 / 0.08), transparent)',
        }}
      />

      <div className="relative z-10 w-full max-w-md px-4">
        <div className="mb-6 flex items-center justify-center gap-2">
          <Star className="h-6 w-6 text-accent" />
          <span className="text-lg font-semibold tracking-tight">
            Crypto Portfolio Tracker
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}
