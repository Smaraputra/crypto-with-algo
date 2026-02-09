'use client';

import { LayoutDashboard, Briefcase, Bell, BarChart3, Star } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/uiStore';
import { WatchlistSidebar } from '@/components/market/WatchlistSidebar';

const NAV_ITEMS = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard, disabled: false },
  { href: '/portfolio', label: 'Portfolio', icon: Briefcase, disabled: false },
  { href: '/alerts', label: 'Alerts', icon: Bell, disabled: false },
  { href: '/analytics', label: 'Analytics', icon: BarChart3, disabled: false },
];

function SidebarContent() {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex h-12 items-center border-b border-sidebar-border px-4">
        <Star className="mr-2 h-4 w-4 text-accent" />
        <span className="text-sm font-semibold">Crypto Tracker</span>
      </div>

      <nav className="space-y-1 p-2">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.label}
            href={item.disabled ? '#' : item.href}
            className={cn(
              'flex items-center gap-3 rounded-sm px-3 py-2 text-sm transition-colors',
              pathname === item.href
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground hover:bg-sidebar-accent',
              item.disabled && 'pointer-events-none opacity-40'
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
            {item.disabled && (
              <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
                Soon
              </span>
            )}
          </Link>
        ))}
      </nav>

      <Separator className="mx-2" />

      <div className="flex-1 overflow-y-auto p-2">
        <WatchlistSidebar />
      </div>
    </div>
  );
}

export function Sidebar() {
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);
  const mobileSidebarOpen = useUIStore((s) => s.mobileSidebarOpen);
  const setMobileSidebarOpen = useUIStore((s) => s.setMobileSidebarOpen);

  return (
    <>
      {/* Desktop sidebar */}
      <aside
        data-testid="desktop-sidebar"
        className={cn(
          'hidden h-full flex-shrink-0 border-r border-border transition-all duration-200 lg:block',
          sidebarOpen ? 'w-56' : 'w-0 overflow-hidden border-r-0'
        )}
      >
        <SidebarContent />
      </aside>

      {/* Mobile sidebar via controlled Sheet */}
      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent side="left" className="w-56 p-0" showCloseButton={false}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarContent />
        </SheetContent>
      </Sheet>
    </>
  );
}
