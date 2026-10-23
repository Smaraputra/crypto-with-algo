'use client';

import { useSyncExternalStore } from 'react';
import { Toaster } from 'sonner';
import { getResolvedTheme, getServerResolvedTheme, subscribeTheme } from '@/lib/theme';

export function ThemedToaster() {
  const theme = useSyncExternalStore(
    subscribeTheme,
    getResolvedTheme,
    getServerResolvedTheme,
  );

  return (
    <Toaster
      theme={theme}
      position="bottom-right"
      toastOptions={{
        style: {
          background: 'var(--card)',
          border: '1px solid var(--border)',
          color: 'var(--foreground)',
        },
      }}
    />
  );
}
