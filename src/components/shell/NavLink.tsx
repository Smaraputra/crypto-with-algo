'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useLinkStatus } from 'next/link';
import { cn } from '@/lib/utils';
import { NavItem, isNavActive } from './nav-items';

export { isNavActive };

export function NavPendingIndicator({ active }: { active: boolean }) {
  const { pending } = useLinkStatus();

  return (
    <span
      data-pending={pending ? 'true' : undefined}
      data-slot="nav-pending-indicator"
      data-testid="nav-pending-indicator"
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-x-3.5 bottom-1 h-[3px] rounded-xs transition-colors duration-120',
        active && !pending && 'bg-brand-line',
        pending && 'bg-muted overflow-hidden motion-reduce:bg-transparent',
        !active && !pending && 'bg-transparent'
      )}
    >
      {pending && (
        <span className="block h-full bg-brand-line motion-reduce:hidden animate-nav-fill" />
      )}
    </span>
  );
}

export interface NavLinkProps extends Omit<React.ComponentProps<typeof Link>, 'href'> {
  item?: NavItem;
  href?: string;
  children?: React.ReactNode;
}

export function NavLink({
  item,
  href: propHref,
  children,
  className,
  onClick,
  ...props
}: NavLinkProps) {
  const pathname = usePathname();
  const targetHref = propHref ?? item?.href ?? '';
  const currentItem: NavItem = item ?? {
    label: typeof children === 'string' ? children : '',
    href: targetHref,
  };
  const active = isNavActive(pathname, currentItem);

  return (
    <Link
      href={targetHref}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'relative inline-flex min-h-[44px] items-center px-3.5 font-semibold transition-colors duration-120 select-none rounded-[10px]',
        'active:scale-[0.98] motion-reduce:active:scale-100',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        active ? 'text-foreground' : 'text-ink-2 hover:bg-muted hover:text-foreground',
        className
      )}
      {...props}
    >
      {children ?? item?.label}
      <NavPendingIndicator active={active} />
    </Link>
  );
}
