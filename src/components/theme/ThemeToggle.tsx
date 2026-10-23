'use client';

import { useSyncExternalStore } from 'react';
import { applyTheme, getResolvedTheme, getServerResolvedTheme, subscribeTheme } from '@/lib/theme';

export function ThemeToggle() {
  const resolvedTheme = useSyncExternalStore(
    subscribeTheme,
    getResolvedTheme,
    getServerResolvedTheme,
  );
  const isDark = resolvedTheme === 'dark';

  return (
    <label className="relative inline-flex min-h-[44px] cursor-pointer items-center gap-2.5 px-1 font-bold text-foreground select-none">
      <input
        type="checkbox"
        role="switch"
        aria-label="Dark"
        checked={isDark}
        onChange={(e) => applyTheme(e.target.checked ? 'dark' : 'light')}
        className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
      />
      <span
        aria-hidden="true"
        className={`relative inline-block h-7 w-12 shrink-0 rounded-full border-2 transition-colors duration-200 motion-reduce:transition-none peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring ${
          isDark ? 'border-foreground bg-foreground' : 'border-edge bg-card'
        }`}
      >
        <span
          className={`absolute top-[3px] left-[3px] h-[18px] w-[18px] rounded-full transition-transform duration-200 motion-reduce:transition-none ${
            isDark
              ? 'translate-x-[20px] bg-background'
              : 'translate-x-0 bg-foreground'
          }`}
        />
      </span>
      <span>Dark</span>
    </label>
  );
}
