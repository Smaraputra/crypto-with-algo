'use client';

import React from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { cn } from '@/lib/utils';

export interface SessionCtaProps {
  className?: string;
}

/**
 * The primary call to action on the public site: "Open dashboard" for a
 * signed-in visitor, "Create a free account" otherwise. While the session is
 * still loading it keeps its space but stays invisible, so a signed-in visitor
 * never sees the sign-up button flash first.
 */
export function SessionCta({ className }: SessionCtaProps) {
  const { status } = useSession();
  const signedIn = status === 'authenticated';
  const loading = status === 'loading';

  return (
    <Link
      href={signedIn ? '/dashboard' : '/register'}
      aria-hidden={loading || undefined}
      tabIndex={loading ? -1 : undefined}
      className={cn(className, loading && 'invisible')}
    >
      {signedIn ? 'Open dashboard' : 'Create a free account'}
    </Link>
  );
}
