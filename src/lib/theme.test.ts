import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_THEME,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
  applyTheme,
  getResolvedTheme,
  getServerResolvedTheme,
  isThemeChoice,
  readStoredTheme,
  resolveTheme,
  subscribeTheme,
  type ThemeChoice,
} from './theme';

describe('theme library', () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    document.documentElement.style.colorScheme = '';
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
  });

  describe('resolveTheme', () => {
    const testCases: Array<{
      choice: ThemeChoice;
      systemPrefersDark: boolean;
      expected: 'light' | 'dark';
    }> = [
      { choice: 'light', systemPrefersDark: false, expected: 'light' },
      { choice: 'light', systemPrefersDark: true, expected: 'light' },
      { choice: 'dark', systemPrefersDark: false, expected: 'dark' },
      { choice: 'dark', systemPrefersDark: true, expected: 'dark' },
      { choice: 'system', systemPrefersDark: false, expected: 'light' },
      { choice: 'system', systemPrefersDark: true, expected: 'dark' },
    ];

    testCases.forEach(({ choice, systemPrefersDark, expected }) => {
      it(`resolves choice "${choice}" with systemPrefersDark=${systemPrefersDark} to "${expected}"`, () => {
        expect(resolveTheme(choice, systemPrefersDark)).toBe(expected);
      });
    });
  });

  describe('isThemeChoice', () => {
    it('returns true for valid theme choices', () => {
      expect(isThemeChoice('light')).toBe(true);
      expect(isThemeChoice('dark')).toBe(true);
      expect(isThemeChoice('system')).toBe(true);
    });

    it('returns false for invalid values', () => {
      expect(isThemeChoice('blue')).toBe(false);
      expect(isThemeChoice('')).toBe(false);
      expect(isThemeChoice(null)).toBe(false);
      expect(isThemeChoice(undefined)).toBe(false);
      expect(isThemeChoice(123)).toBe(false);
      expect(isThemeChoice({})).toBe(false);
    });
  });

  describe('readStoredTheme', () => {
    it('returns DEFAULT_THEME when localStorage is empty', () => {
      expect(readStoredTheme()).toBe(DEFAULT_THEME);
    });

    it('returns DEFAULT_THEME when stored value is invalid', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'invalid');
      expect(readStoredTheme()).toBe(DEFAULT_THEME);
    });

    it('returns stored value when valid', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'light');
      expect(readStoredTheme()).toBe('light');

      localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      expect(readStoredTheme()).toBe('dark');

      localStorage.setItem(THEME_STORAGE_KEY, 'system');
      expect(readStoredTheme()).toBe('system');
    });

    it('returns DEFAULT_THEME if localStorage throws', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('Storage access blocked');
      });
      expect(readStoredTheme()).toBe(DEFAULT_THEME);
    });
  });

  describe('applyTheme', () => {
    it('removes the dark class, sets colorScheme light, and stores light', () => {
      document.documentElement.classList.add('dark');
      applyTheme('light');

      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(document.documentElement.style.colorScheme).toBe('light');
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    });

    it('adds dark class with system choice when matchMedia matches true', () => {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('dark'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

      applyTheme('system');

      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.style.colorScheme).toBe('dark');
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
    });

    it('removes dark class with system choice when matchMedia matches false', () => {
      document.documentElement.classList.add('dark');
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

      applyTheme('system');

      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(document.documentElement.style.colorScheme).toBe('light');
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
    });
  });

  describe('THEME_INIT_SCRIPT', () => {
    it('executing script with no stored value adds dark and sets colorScheme dark', () => {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
      }));

      const runner = new Function(THEME_INIT_SCRIPT);
      runner();

      expect(document.documentElement.classList.contains('dark')).toBe(true);
      expect(document.documentElement.style.colorScheme).toBe('dark');
    });

    it('executing script with stored light removes dark and sets colorScheme light', () => {
      document.documentElement.classList.add('dark');
      localStorage.setItem(THEME_STORAGE_KEY, 'light');

      const runner = new Function(THEME_INIT_SCRIPT);
      runner();

      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(document.documentElement.style.colorScheme).toBe('light');
    });
  });

  describe('store hooks', () => {
    it('getServerResolvedTheme returns dark', () => {
      expect(getServerResolvedTheme()).toBe('dark');
    });

    it('getResolvedTheme reflects documentElement classList', () => {
      document.documentElement.classList.remove('dark');
      expect(getResolvedTheme()).toBe('light');

      document.documentElement.classList.add('dark');
      expect(getResolvedTheme()).toBe('dark');
    });

    it('subscribeTheme notifies on class change and unobserves on unsubscribe', async () => {
      const listener = vi.fn();
      const unsubscribe = subscribeTheme(listener);

      document.documentElement.classList.toggle('dark');

      // Wait for MutationObserver callback
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(listener).toHaveBeenCalled();

      listener.mockClear();
      unsubscribe();

      document.documentElement.classList.toggle('dark');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('interim accent tokens', () => {
    it('globals.css defines interim brand accent for unrebuilt screens in :root and .dark', () => {
      const globalsCss = readFileSync(join(__dirname, '../app/globals.css'), 'utf8');
      const rootBlock = globalsCss.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
      const darkBlock = globalsCss.match(/\.dark\s*\{([\s\S]*?)\}/)?.[1] ?? '';

      expect(rootBlock).toContain('--accent: #067346;');
      expect(darkBlock).toContain('--accent: #00C57C;');
    });
  });

  describe('brand tokens and retired brand palette', () => {
    it('asserts :root and .dark both contain --brand: #00C57C; and no retired brand hexes remain', () => {
      const globalsCss = readFileSync(join(__dirname, '../app/globals.css'), 'utf8');
      const rootBlock = globalsCss.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? '';
      const darkBlock = globalsCss.match(/\.dark\s*\{([\s\S]*?)\}/)?.[1] ?? '';

      expect(rootBlock).toContain('--brand: #00C57C;');
      expect(darkBlock).toContain('--brand: #00C57C;');

      const retiredHexes = ['#FF6F0F', '#FF7A1F', '#B03E00', '#FF9A52', '#12100D'];
      for (const hex of retiredHexes) {
        expect(globalsCss).not.toContain(hex);
      }
    });
  });
});
