export type ThemeChoice = 'light' | 'dark' | 'system';
export const THEME_STORAGE_KEY = 'cwa-theme';
export const DEFAULT_THEME: ThemeChoice = 'system';

export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): 'light' | 'dark' {
  if (choice === 'system') return systemPrefersDark ? 'dark' : 'light';
  return choice;
}

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'light' || value === 'dark' || value === 'system';
}

// Runs in <head> before first paint so the page never flashes the wrong theme.
export const THEME_INIT_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_STORAGE_KEY)};var d=${JSON.stringify(DEFAULT_THEME)};var c=localStorage.getItem(k);if(c!=='light'&&c!=='dark'&&c!=='system'){c=d}var m=window.matchMedia?window.matchMedia('(prefers-color-scheme: dark)').matches:false;var t=c==='system'?(m?'dark':'light'):c;var r=document.documentElement;r.classList.toggle('dark',t==='dark');r.style.colorScheme=t}catch(e){}})();`;

const subscribers = new Set<() => void>();

function notifySubscribers(): void {
  for (const subscriber of subscribers) {
    subscriber();
  }
}

export function applyTheme(choice: ThemeChoice): void {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(THEME_STORAGE_KEY, choice);
    }
  } catch {
    // Ignore storage errors.
  }

  const systemPrefersDark =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false;

  const resolved = resolveTheme(choice, systemPrefersDark);

  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
    document.documentElement.style.colorScheme = resolved;
  }

  notifySubscribers();
}

export function readStoredTheme(): ThemeChoice {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
      if (isThemeChoice(stored)) {
        return stored;
      }
    }
  } catch {
    // Ignore storage errors.
  }
  return DEFAULT_THEME;
}

export function subscribeTheme(callback: () => void): () => void {
  let lastTheme = getResolvedTheme();

  const notifyIfChanged = () => {
    const current = getResolvedTheme();
    if (current !== lastTheme) {
      lastTheme = current;
      callback();
    }
  };

  subscribers.add(notifyIfChanged);

  let observer: MutationObserver | null = null;
  if (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof MutationObserver !== 'undefined'
  ) {
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          notifyIfChanged();
          break;
        }
      }
    });

    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  return () => {
    subscribers.delete(notifyIfChanged);
    observer?.disconnect();
  };
}

export function getResolvedTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') {
    return DEFAULT_THEME === 'system' ? 'dark' : DEFAULT_THEME;
  }
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function getServerResolvedTheme(): 'dark' {
  return 'dark';
}
