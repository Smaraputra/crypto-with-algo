'use client';

import { useLinkStatus } from 'next/link';

export function NavPendingIndicator() {
  const { pending } = useLinkStatus();
  return (
    <span
      aria-hidden="true"
      data-testid="nav-pending-indicator"
      data-pending={pending ? 'true' : 'false'}
      className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-primary opacity-0 transition-opacity duration-150 data-[pending=true]:opacity-100 data-[pending=true]:delay-100 data-[pending=true]:animate-pulse"
    />
  );
}
