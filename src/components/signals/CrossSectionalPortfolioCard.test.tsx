import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CrossSectionalPortfolioCard } from './CrossSectionalPortfolioCard';
import * as useSignalsHooks from '@/hooks/useSignals';
import type { RvFillStats } from '@/lib/models/rv-book';
import type { RvStepRecord } from '@/lib/signals/cross-sectional/engine';
import type { RvBookView, RvLatestResponse, RvStepView } from '@/lib/paper-desk/rv-latest';

const BAR = 8 * 3_600_000;
/** Wednesday 2026-10-14 00:00 UTC. */
const T0 = 1_791_936_000_000;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'AVAXUSDT', 'XRPUSDT', 'ADAUSDT', 'LINKUSDT', 'DOGEUSDT'];

type HookResult = ReturnType<typeof useSignalsHooks.useCrossSectionalLatest>;

function mockHook(result: Partial<HookResult>) {
  const refetch = vi.fn();
  vi.spyOn(useSignalsHooks, 'useCrossSectionalLatest').mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    dataUpdatedAt: 0,
    refetch,
    ...result,
  } as unknown as HookResult);
  return refetch;
}

function fillStats(filled: number, fallback: number): RvFillStats {
  const empty = { makerFilled: 0, makerFallback: 0, steps: 0 };
  return {
    '00': { makerFilled: filled, makerFallback: fallback, steps: 3 },
    '08': { ...empty },
    '16': { ...empty },
    weekday: { makerFilled: filled, makerFallback: fallback, steps: 3 },
    weekend: { ...empty },
  };
}

function record(overrides: Partial<RvStepRecord> = {}): RvStepRecord {
  return {
    equityBefore: 10_120,
    equityAfter: 10_125.5,
    funding: [],
    fills: [],
    fees: 3.64,
    realizedPnl: 0,
    unrealizedPnl: 0,
    stale: [],
    skippedEntries: [],
    halted: null,
    gross: 1.02,
    ...overrides,
  };
}

function book(overrides: Partial<RvBookView> = {}): RvBookView {
  return {
    bookName: 'rv-v1',
    version: 'rv-v1',
    validationStatus: 'unvalidated',
    validationRef: null,
    startedAt: '2026-10-14T09:05:00.000Z',
    startBarTime: T0,
    lastStepBarTime: T0 + BAR,
    tracks: {
      taker: {
        cash: 10_000,
        positions: {
          BTCUSDT: { qty: 0.04, avgEntry: 64_000, lastMark: 65_000 },
          AVAXUSDT: { qty: 80, avgEntry: 31, lastMark: 30 },
          DOGEUSDT: { qty: -16_000, avgEntry: 0.16, lastMark: 0.15 },
          SOLUSDT: { qty: -16, avgEntry: 150, lastMark: 151.25 },
        },
      },
      maker: {
        cash: 10_000,
        positions: {
          BTCUSDT: { qty: 0.04, avgEntry: 63_950, lastMark: 65_000 },
          AVAXUSDT: { qty: 80, avgEntry: 30.98, lastMark: 30 },
          DOGEUSDT: { qty: -16_000, avgEntry: 0.1601, lastMark: 0.15 },
          SOLUSDT: { qty: -16, avgEntry: 150.1, lastMark: 151.25 },
        },
      },
    },
    equity: { taker: 10_125.5, maker: 10_180.25 },
    peakEquity: { taker: 10_200, maker: 10_250 },
    alerts: { drawdownTaker: false, drawdownMaker: false, negativeStreak: 0 },
    fillStats: fillStats(5, 3),
    createdAt: '2026-10-14T09:05:00.000Z',
    updatedAt: '2026-10-14T17:05:00.000Z',
    ...overrides,
  };
}

function completedStep(overrides: Partial<RvStepView> = {}): RvStepView {
  return {
    bookName: 'rv-v1',
    barTime: T0 + BAR,
    fillTime: T0 + 2 * BAR,
    targets: { BTCUSDT: 0.26, AVAXUSDT: 0.24, DOGEUSDT: -0.24, SOLUSDT: -0.24 },
    taker: record(),
    maker: record({ equityAfter: 10_180.25 }),
    bookAfter: book(),
    rebalanceHourUtc: 16,
    isWeekend: false,
    pendingReasons: [],
    createdAt: '2026-10-14T17:05:00.000Z',
    ...overrides,
  };
}

function response(overrides: Partial<RvLatestResponse> = {}): RvLatestResponse {
  const done = completedStep();
  return {
    success: true,
    signal: {
      version: 'rv-v1',
      barTime: T0 + BAR,
      barCloseTime: T0 + 2 * BAR,
      rows: SYMBOLS.map((symbol, i) => ({
        symbol,
        mom: 0,
        idio: 0,
        carry: 0,
        flow: 0,
        beta: 0.9 + i * 0.07,
        zMom: 1 - i / 4,
        zIdio: 0.5,
        zCarry: -0.25,
        zFlow: 0.1,
      })),
      ranked: SYMBOLS.map((symbol, i) => ({ symbol, compositeZ: 1.2 - i * 0.3, rank: i + 1 })),
      skipped: [{ symbol: 'DOTUSDT', reason: 'carry_stale' }],
      inputs: { lastBarOpenTime: {}, settlement: {} },
      createdAt: '2026-10-14T16:01:00.000Z',
    },
    step: done,
    completedStep: done,
    book: book(),
    costs: { takerFee: 0.0005, makerFee: 0.0002, takerSlippageBps: 2 },
    rule: { weights: { mom: 0.3, idio: 0.25, carry: 0.3, flow: 0.15 }, legs: 2, startingEquity: 10_000, drawdownFlag: 0.15 },
    lastAlert: null,
    legacy: null,
    ...overrides,
  };
}

const positionsTable = () => screen.getByRole('table', { name: /positions/i });

/** A paragraph whose whole text is `text`, even when a timestamp inside it sits in its own span. */
const paragraph = (text: string) =>
  screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === text);

const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CrossSectionalPortfolioCard states', () => {
  it('shows a labelled loading state while the request is in flight', () => {
    mockHook({ isLoading: true });
    const { container } = render(<CrossSectionalPortfolioCard />);
    expect(container.querySelector('.animate-shimmer')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading the rv-v1 paper desk');
  });

  it('shows the API error, not an awaiting message, when the request fails, and retries on demand', () => {
    const refetch = mockHook({ isError: true, error: new Error('Could not read the rv-v1 desk') });
    render(<CrossSectionalPortfolioCard />);

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the rv-v1 paper desk: Could not read the rv-v1 desk');
    expect(screen.queryByText(/awaiting/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the not validated badge beside the title when the request fails', () => {
    mockHook({ isError: true, error: new Error('Could not read the rv-v1 desk') });
    render(<CrossSectionalPortfolioCard />);

    expect(screen.getByText('8h Relative Value, rv-v1')).toBeInTheDocument();
    expect(screen.getByText('Not validated')).toBeInTheDocument();
  });

  it('shows an empty state when no book exists yet', () => {
    mockHook({ data: response({ book: null, step: null, completedStep: null }) });
    render(<CrossSectionalPortfolioCard />);

    expect(screen.getByText('8h Relative Value, rv-v1')).toBeInTheDocument();
    expect(screen.getByText('Not validated')).toBeInTheDocument();
    expect(screen.getByText('Experimental. Not validated. Paper only.')).toBeInTheDocument();
    expect(
      screen.getByText('No rv-v1 book yet. The paper desk creates it on its first run, at 01:05, 09:05 or 17:05 UTC.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Taker track')).not.toBeInTheDocument();
  });

  it('shows a book with no completed step at its starting equity', () => {
    const fresh = book({
      lastStepBarTime: null,
      startBarTime: null,
      tracks: { taker: { cash: 10_000, positions: {} }, maker: { cash: 10_000, positions: {} } },
      equity: { taker: 10_000, maker: 10_000 },
      fillStats: fillStats(0, 0),
    });
    mockHook({ data: response({ book: fresh, step: null, completedStep: null }) });
    render(<CrossSectionalPortfolioCard />);

    expect(screen.getByText('No completed step yet')).toBeInTheDocument();
    expect(screen.getAllByText('$10,000.00')).toHaveLength(2);
    expect(screen.getAllByText('$0.00 (0.00%) since start')).toHaveLength(2);
    expect(screen.getByText('No open positions.')).toBeInTheDocument();
  });

  it('keeps the data on screen and says so when a refresh fails', () => {
    mockHook({
      data: response(),
      isError: true,
      error: new Error('Request failed with status 502'),
      dataUpdatedAt: Date.UTC(2026, 9, 14, 17, 30),
    });
    render(<CrossSectionalPortfolioCard />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Refresh failed (Request failed with status 502). Showing data loaded at 2026-10-14 17:30 UTC.'
    );
    expect(screen.getByText('$10,125.50')).toBeInTheDocument();
  });
});

describe('CrossSectionalPortfolioCard copy (D21)', () => {
  it('labels an unvalidated book as experimental, not validated and paper only', () => {
    mockHook({ data: response() });
    render(<CrossSectionalPortfolioCard />);

    expect(screen.getByText('8h Relative Value, rv-v1')).toBeInTheDocument();
    expect(screen.getByText('Not validated')).toBeInTheDocument();
    expect(
      screen.getByText('Experimental. Descriptive forward record since 2026-10-14. Not validated. Paper only.')
    ).toBeInTheDocument();
  });

  it('labels a validated book from its status and reference, with no not-validated copy', () => {
    mockHook({ data: response({ book: book({ validationStatus: 'validated', validationRef: 'sessions/rv-v1-revalidation.md' }) }) });
    const { container } = render(<CrossSectionalPortfolioCard />);

    expect(screen.getByText('Validated')).toBeInTheDocument();
    expect(
      screen.getByText('Descriptive forward record since 2026-10-14. Validated, see sessions/rv-v1-revalidation.md. Paper only.')
    ).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/not validated/i);
  });

  it('labels a rejected book', () => {
    mockHook({ data: response({ book: book({ validationStatus: 'rejected' }) }) });
    const { container } = render(<CrossSectionalPortfolioCard />);

    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(
      screen.getByText('Descriptive forward record since 2026-10-14. Rejected by re-validation. Paper only.')
    ).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/not validated/i);
  });

  it('states the costs of both tracks from the rule, and never the old 1.8 bps profile', () => {
    mockHook({ data: response() });
    const { container } = render(<CrossSectionalPortfolioCard />);

    expect(screen.getByText('Taker 5 bps + 2 bps slippage')).toBeInTheDocument();
    expect(
      screen.getByText('Maker 2 bps (fills only if the first hour trades through the open, else taker)')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show the ranking/i }));
    // The bps figure, not any "1.8": the maker track's +1.80% change since start is legitimate
    expect(container.textContent).not.toMatch(/1\.80*\s*bps/);
  });

  it('names the price source and the carry definition, with no mark price label', () => {
    mockHook({ data: response() });
    const { container } = render(<CrossSectionalPortfolioCard />);

    expect(container.textContent).toContain('Binance USDT-M perp prices');
    expect(container.textContent).toContain('Carry = minus the latest settled funding rate');
    expect(within(positionsTable()).getByRole('columnheader', { name: 'Last price' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/mark price/i);
  });

  it('keeps every visible sentence free of semicolons and long dashes', () => {
    mockHook({
      data: response({
        book: book({ alerts: { drawdownTaker: true, drawdownMaker: true, negativeStreak: 12 } }),
        legacy: { bookName: 'rv-8h-buffer2', equityMaker: 10_250.75, equityTaker: 10_010.25, lastProcessedBarTime: T0 - BAR },
      }),
    });
    const { container } = render(<CrossSectionalPortfolioCard />);
    fireEvent.click(screen.getByRole('button', { name: /show the ranking/i }));
    expect(container.textContent).not.toMatch(/[;–—]/);
  });
});

describe('CrossSectionalPortfolioCard figures', () => {
  it('shows both tracks, their change since start and the as-of time of the last completed step', () => {
    mockHook({ data: response() });
    render(<CrossSectionalPortfolioCard />);

    expect(screen.getByText('Taker track')).toBeInTheDocument();
    expect(screen.getByText('Maker track')).toBeInTheDocument();
    expect(screen.getByText('$10,125.50')).toBeInTheDocument();
    expect(screen.getByText('$10,180.25')).toBeInTheDocument();
    expect(screen.getByText('+$125.50 (+1.26%) since start')).toBeInTheDocument();
    expect(screen.getByText('+$180.25 (+1.80%) since start')).toBeInTheDocument();
    expect(screen.getByText('As of 2026-10-14 16:00 UTC')).toBeInTheDocument();
  });

  it('renders a zero change as $0.00 and a loss with a minus sign', () => {
    mockHook({ data: response({ book: book({ equity: { taker: 9_987.6, maker: 10_000 } }) }) });
    render(<CrossSectionalPortfolioCard />);

    expect(screen.getByText('$0.00 (0.00%) since start')).toBeInTheDocument();
    expect(screen.getByText('-$12.40 (-0.12%) since start')).toBeInTheDocument();
  });

  it('drops the percent when the starting equity is not positive', () => {
    mockHook({
      data: response({
        rule: { ...response().rule, startingEquity: 0 },
      }),
    });
    const { container } = render(<CrossSectionalPortfolioCard />);

    expect(screen.getByText('+$10,125.50 since start')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/%\) since start/);
  });

  it('shows a weight as n/a in the muted colour when the track equity is not positive', () => {
    mockHook({ data: response({ book: book({ equity: { taker: 0, maker: 10_180.25 } }) }) });
    render(<CrossSectionalPortfolioCard />);

    const rows = within(positionsTable()).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const weight = within(row).getAllByRole('cell')[1];
      expect(weight).not.toHaveTextContent(/%|Infinity|NaN/);
      const na = within(weight).getByText('n/a');
      expect(na).toHaveClass('text-muted-foreground');
    }
  });

  it('keeps the sign of a negative equity', () => {
    mockHook({ data: response({ book: book({ equity: { taker: -1_234.56, maker: 10_180.25 } }) }) });
    render(<CrossSectionalPortfolioCard />);

    expect(screen.getByText('-$1,234.56')).toBeInTheDocument();
    expect(screen.getByText('-$11,234.56 (-112.35%) since start')).toBeInTheDocument();
    expect(screen.getByText('$10,180.25')).toBeInTheDocument();
  });

  it('lists positions from the book, not from the latest signal ranking', () => {
    mockHook({ data: response() });
    render(<CrossSectionalPortfolioCard />);

    const rows = within(positionsTable()).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual([
      expect.stringContaining('BTC'),
      expect.stringContaining('AVAX'),
      expect.stringContaining('SOL'),
      expect.stringContaining('DOGE'),
    ]);
    // ETH is ranked 2 by the signal but the book does not hold it
    expect(within(positionsTable()).queryByText(/ETH/)).not.toBeInTheDocument();

    const btc = rows[0];
    expect(btc).toHaveTextContent('Long');
    expect(btc).toHaveTextContent('+25.68%');
    expect(btc).toHaveTextContent('64,000.00');
    expect(btc).toHaveTextContent('65,000.00');
    expect(btc).toHaveTextContent('+$40.00');
    expect(btc).toHaveTextContent('+$42.00');
    expect(rows[2]).toHaveTextContent('-23.90%');
    expect(rows[3]).toHaveTextContent('Short');
    expect(rows[3]).toHaveTextContent('0.15000');
    expect(rows[3]).toHaveTextContent('+$160.00');
  });

  it('badges a symbol the last completed step could not price as stale', () => {
    mockHook({ data: response({ completedStep: completedStep({ taker: record({ stale: ['DOGEUSDT'] }) }) }) });
    render(<CrossSectionalPortfolioCard />);

    const rows = within(positionsTable()).getAllByRole('row').slice(1);
    expect(within(rows[3]).getByText('Stale')).toBeInTheDocument();
    expect(within(rows[0]).queryByText('Stale')).not.toBeInTheDocument();
    expect(
      screen.getByText('Stale: no 1h perp bar at the last step, so the last price is from an earlier step.')
    ).toBeInTheDocument();
  });

  it('badges a symbol as stale when only the maker track could not price it', () => {
    mockHook({
      data: response({
        completedStep: completedStep({ taker: record({ stale: [] }), maker: record({ stale: ['SOLUSDT'] }) }),
      }),
    });
    render(<CrossSectionalPortfolioCard />);

    const rows = within(positionsTable()).getAllByRole('row').slice(1);
    expect(rows[2]).toHaveTextContent('SOL');
    expect(within(rows[2]).getByText('Stale')).toBeInTheDocument();
    expect(within(positionsTable()).getAllByText('Stale')).toHaveLength(1);
  });

  it('shows the maker fill rate from the book fill counts', () => {
    mockHook({ data: response() });
    render(<CrossSectionalPortfolioCard />);
    expect(screen.getByText('Maker fill rate 63% (5 of 8 orders)')).toBeInTheDocument();
  });

  it('says no maker fills yet instead of a 0% or NaN rate', () => {
    mockHook({ data: response({ book: book({ fillStats: fillStats(0, 0) }) }) });
    const { container } = render(<CrossSectionalPortfolioCard />);
    expect(screen.getByText('No maker fills yet')).toBeInTheDocument();
    expect(container.textContent).not.toContain('NaN');
    expect(container.textContent).not.toMatch(/maker fill rate 0%/i);
  });

  it('says how many orders fell back when none filled as maker', () => {
    mockHook({ data: response({ book: book({ fillStats: fillStats(0, 4) }) }) });
    render(<CrossSectionalPortfolioCard />);
    expect(screen.getByText('No maker fills yet, 4 orders fell back to taker')).toBeInTheDocument();
  });
});

describe('CrossSectionalPortfolioCard flags and pending steps', () => {
  it('badges each raised flag and says flags never stop the desk', () => {
    mockHook({ data: response({ book: book({ alerts: { drawdownTaker: true, drawdownMaker: true, negativeStreak: 12 } }) }) });
    render(<CrossSectionalPortfolioCard />);

    expect(screen.getByText('Taker track 15% or more below its peak')).toBeInTheDocument();
    expect(screen.getByText('Maker track 15% or more below its peak')).toBeInTheDocument();
    expect(screen.getByText('Taker equity lower for 12 steps in a row')).toBeInTheDocument();
    expect(screen.getByText('Flags are descriptive. The desk keeps trading.')).toBeInTheDocument();
  });

  it('does not badge a negative streak below 10', () => {
    mockHook({ data: response({ book: book({ alerts: { drawdownTaker: false, drawdownMaker: false, negativeStreak: 9 } }) }) });
    render(<CrossSectionalPortfolioCard />);
    expect(screen.queryByText(/steps in a row/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Flags are descriptive/)).not.toBeInTheDocument();
  });

  it('shows when a flag was last raised once none is raised now', () => {
    mockHook({ data: response({ lastAlert: { barTime: T0, fillTime: T0 + BAR, kinds: ['drawdown_taker', 'negative_streak'] } }) });
    render(<CrossSectionalPortfolioCard />);
    expect(
      paragraph('No flag raised now. Last flagged 2026-10-14 08:00 UTC (taker drawdown, negative streak).')
    ).toBeInTheDocument();
  });

  it('shows a pending step as waiting on data and keeps the last completed figures with their own time', () => {
    const pending: RvStepView = {
      ...completedStep({ barTime: T0 + 2 * BAR, fillTime: T0 + 3 * BAR }),
      targets: null,
      taker: null,
      maker: null,
      bookAfter: null,
      pendingReasons: [
        'fill_bar_unavailable:SOLUSDT (fetch failed: timeout)',
        'held_symbol_unscored: DOGEUSDT is held but missing from the ranking',
      ],
    };
    mockHook({ data: response({ step: pending }) });
    const { container } = render(<CrossSectionalPortfolioCard />);

    const waiting = screen.getByRole('region', { name: 'Waiting on data' });
    expect(waiting).toHaveTextContent(
      'The step for the bar closing 2026-10-15 00:00 UTC is pending. The desk retries it on every run.'
    );
    expect(waiting).toHaveTextContent('The figures below are from the last completed step.');
    expect(within(waiting).getByText('fill_bar_unavailable:SOLUSDT')).toBeInTheDocument();
    expect(within(waiting).getByText('held_symbol_unscored')).toBeInTheDocument();
    expect(container.textContent).not.toContain('fetch failed');
    expect(screen.getByText('As of 2026-10-14 16:00 UTC')).toBeInTheDocument();
    expect(screen.getByText('$10,125.50')).toBeInTheDocument();
  });

  it('does not treat a pending orphan behind the cursor as waiting', () => {
    const orphan: RvStepView = { ...completedStep({ barTime: T0 }), bookAfter: null, taker: null, maker: null, pendingReasons: ['funding_missing:SOLUSDT'] };
    mockHook({ data: response({ step: orphan }) });
    render(<CrossSectionalPortfolioCard />);
    expect(screen.queryByRole('region', { name: 'Waiting on data' })).not.toBeInTheDocument();
  });
});

describe('CrossSectionalPortfolioCard ranking and history', () => {
  it('reveals the latest ranking with the skipped symbols on demand', () => {
    mockHook({ data: response() });
    render(<CrossSectionalPortfolioCard />);

    const toggle = screen.getByRole('button', { name: 'Show the ranking for the bar closing 2026-10-14 16:00 UTC' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('table', { name: /ranking/i })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const ranking = screen.getByRole('table', { name: /ranking/i });
    const first = within(ranking).getAllByRole('row')[1];
    expect(first).toHaveTextContent('1');
    expect(first).toHaveTextContent('BTC');
    expect(first).toHaveTextContent('+1.20');
    expect(screen.getByText('Not scored for this bar: DOT (funding settlement stale).')).toBeInTheDocument();
  });

  it('says so when no signal is stored yet', () => {
    mockHook({ data: response({ signal: null }) });
    render(<CrossSectionalPortfolioCard />);
    expect(screen.getByText('No rv-v1 signal stored yet.')).toBeInTheDocument();
  });

  it('notes the archived legacy book as read-only', () => {
    mockHook({
      data: response({
        legacy: { bookName: 'rv-8h-buffer2', equityMaker: 10_250.75, equityTaker: 10_010.25, lastProcessedBarTime: T0 - BAR },
      }),
    });
    render(<CrossSectionalPortfolioCard />);
    expect(
      paragraph(
        'Archived: book rv-8h-buffer2 (spot prices, pre-rv-v1 rules) is read-only and no longer stepped. Last signal processed 2026-10-13 16:00 UTC, taker $10,010.25, maker $10,250.75.'
      )
    ).toBeInTheDocument();
  });

  it('never breaks a timestamp inside a sentence across lines', () => {
    const pending: RvStepView = {
      ...completedStep({ barTime: T0 + 2 * BAR, fillTime: T0 + 3 * BAR }),
      bookAfter: null,
      taker: null,
      maker: null,
      pendingReasons: ['funding_missing:SOLUSDT'],
    };
    mockHook({
      data: response({
        step: pending,
        lastAlert: { barTime: T0, fillTime: T0 + BAR, kinds: ['drawdown_taker'] },
        legacy: { bookName: 'rv-8h-buffer2', equityMaker: 10_250.75, equityTaker: 10_010.25, lastProcessedBarTime: T0 - BAR },
      }),
      isError: true,
      error: new Error('Request failed with status 502'),
      dataUpdatedAt: Date.UTC(2026, 9, 14, 17, 30),
    });
    render(<CrossSectionalPortfolioCard />);

    const stamps = screen.getAllByText(STAMP);
    // pending step, last flagged, legacy note, refresh failure and the ranking button
    expect(stamps).toHaveLength(5);
    for (const stamp of stamps) expect(stamp).toHaveClass('whitespace-nowrap');
  });
});
