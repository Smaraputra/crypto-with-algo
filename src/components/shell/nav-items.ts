export interface NavItem {
  label: string;
  href: string;
  matchPaths?: string[];
  interim?: boolean;
  removalReason?: string;
}

export const PRIMARY_NAV_ITEMS: NavItem[] = [
  { label: 'Market', href: '/dashboard', matchPaths: ['/dashboard', '/focus', '/signals'] },
  { label: 'Lab', href: '/lab', matchPaths: ['/lab'] },
  { label: 'Portfolio', href: '/portfolio', matchPaths: ['/portfolio', '/analytics'] },
  { label: 'Journal', href: '/journal', matchPaths: ['/journal', '/research', '/notes'] },
  { label: 'Alerts', href: '/alerts', matchPaths: ['/alerts'] },
];

export const TOOLS_NAV_ITEMS: NavItem[] = [
  { label: 'Cost Check', href: '/cost-check' },
  { label: 'Backtest', href: '/backtest' },
];

export const TOOLS_MATCH_PATHS = ['/cost-check', '/backtest'];

export const PHONE_NAV_ITEMS: NavItem[] = [
  { label: 'Market', href: '/dashboard', matchPaths: ['/dashboard', '/focus', '/signals'] },
  { label: 'Lab', href: '/lab', matchPaths: ['/lab'] },
  { label: 'Portfolio', href: '/portfolio', matchPaths: ['/portfolio', '/analytics'] },
  { label: 'Journal', href: '/journal', matchPaths: ['/journal', '/research', '/notes'] },
];

export const MORE_SHEET_ITEMS: NavItem[] = [
  { label: 'Alerts', href: '/alerts' },
  { label: 'Cost Check', href: '/cost-check' },
  { label: 'Backtest', href: '/backtest' },
  { label: 'Notes', href: '/notes' },
  { label: 'Signals', href: '/signals' },
];

export const ADMIN_NAV_ITEMS: NavItem[] = [
  { label: 'Admin calibration', href: '/admin/calibration' },
  { label: 'Admin paper desk', href: '/admin/paper-desk' },
];

function normalizePath(rawPath: string): string {
  const withoutQueryOrHash = rawPath.split('?')[0].split('#')[0];
  if (withoutQueryOrHash.length > 1 && withoutQueryOrHash.endsWith('/')) {
    return withoutQueryOrHash.slice(0, -1);
  }
  return withoutQueryOrHash;
}

export function isNavActive(pathname: string, item: NavItem | string): boolean {
  const norm = normalizePath(pathname);

  if (typeof item === 'string') {
    if (item === 'Tools' || item === '/tools') {
      return TOOLS_MATCH_PATHS.some((p) => norm === p || norm.startsWith(`${p}/`));
    }
    const found = [
      ...PRIMARY_NAV_ITEMS,
      ...TOOLS_NAV_ITEMS,
      { label: 'Tools', href: '/cost-check', matchPaths: TOOLS_MATCH_PATHS },
    ].find((i) => i.href === item || i.label.toLowerCase() === item.toLowerCase());

    if (found) {
      return isNavActive(pathname, found);
    }
    const target = normalizePath(item);
    return norm === target || norm.startsWith(`${target}/`);
  }

  if (item.label === 'Tools') {
    return TOOLS_MATCH_PATHS.some((p) => norm === p || norm.startsWith(`${p}/`));
  }

  if (item.matchPaths && item.matchPaths.length > 0) {
    return item.matchPaths.some((p) => norm === p || norm.startsWith(`${p}/`));
  }

  const target = normalizePath(item.href);
  return norm === target || norm.startsWith(`${target}/`);
}
