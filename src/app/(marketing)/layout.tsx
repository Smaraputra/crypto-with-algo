import { SmoothScroll } from '@/components/marketing/SmoothScroll';
import { CursorGlow } from '@/components/marketing/CursorGlow';

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="marketing-dark">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only fixed top-2 left-2 z-[100] rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <CursorGlow />
      <SmoothScroll>{children}</SmoothScroll>
    </div>
  );
}
