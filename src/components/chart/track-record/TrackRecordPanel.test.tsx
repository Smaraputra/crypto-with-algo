import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { pointMeasures } from '@/lib/signals/track-record/measures';
import type { TrackRecordResponse } from '@/lib/signals/track-record/types';

import { HitRateRuler, rulerDomain } from './HitRateRuler';
import { MonthBars } from './MonthBars';
import { TrackRecordPanel } from './TrackRecordPanel';

const query = vi.hoisted(() => ({ state: {} as Record<string, unknown>, refetch: vi.fn() }));
vi.mock('@/hooks/useTrackRecord', () => ({
  useTrackRecord: () => ({ ...query.state, refetch: query.refetch }),
}));

const LIVE_SINCE = Date.UTC(2026, 9, 1, 18);

const btcMeasures = {
  ...pointMeasures([], 0.16),
  calls: 1902,
  buyN: 1021,
  sellN: 881,
  buyHit: 0.4505,
  sellHit: 0.437,
  bh: 0.4438,
  right: 0.4443,
  meanBefore: -0.0831,
  net: -0.2431,
  wonAfterCost: 0.4043,
  avgWin: 1.7549,
  avgLoss: 1.5524,
  breakEven: 0.5178,
};

function available(over: Partial<Extract<TrackRecordResponse, { available: true }>> = {}): TrackRecordResponse {
  return {
    available: true,
    run: {
      runId: 'v8-rescore-2026-10-10',
      configVersion: 8,
      windowStart: '2025-10-01T00:00:00.000Z',
      windowEnd: '2026-10-09T23:59:59.999Z',
      cutoffs: { buy: 28, strong: 36 },
      rowsSha256: '2addedf2b2ce8d2e22d04a3f58fb207867f09f9546b25c7ee87e89f7e0967d68',
      reportSha256: '2e19b91553c06f4adcc6f5adfb5d36c9edaaa99075069e99bf5400a040262c74',
      gitCommit: '663e4a1680293dc0f4f37606d48373f9659be312',
      resamples: 1000,
      seed: 13,
      loadedAt: '2026-10-10T16:55:47.704Z',
    },
    cell: {
      style: 'day_trading',
      interval: '1h',
      horizonBars: 24,
      costPercent: 0.16,
      pooled: {
        rows: 89520,
        buyN: 7874,
        sellN: 7987,
        bh: 0.4412,
        bhLo: 0.3868,
        bhHi: 0.4949,
        net: -0.2361,
        netLo: -0.7197,
        netHi: 0.2308,
        spearman: -0.0465,
        level: 1 - 0.05 / 6,
        verdict: 'NO DETECTABLE EDGE',
      },
      parity: { matched: 1740, sameTierShare: 0.9994, scoreCorrelation: 0.99999 },
    },
    symbol: {
      symbol: 'BTCUSDT',
      first: Date.UTC(2025, 9, 1),
      last: Date.UTC(2026, 9, 8, 23),
      liveSince: LIVE_SINCE,
      measures: btcMeasures,
      intervals: { right: { lo: 0.3845, hi: 0.5025 }, bh: { lo: 0.3845, hi: 0.501 }, net: { lo: -0.5365, hi: 0.0388 } },
      months: [
        { month: '2025-10', calls: 160, right: 0.41, bh: 0.41, net: -0.31 },
        { month: '2025-11', calls: 150, right: 0.52, bh: 0.52, net: 0.12 },
        { month: '2025-12', calls: 0, right: null, bh: null, net: null },
      ],
    },
    live: {
      since: LIVE_SINCE,
      resolved: 120,
      pending: 7,
      measures: { ...pointMeasures([], 0.16), calls: 120, buyN: 70, sellN: 50, right: 0.45, net: -0.19 },
    },
    boundary: LIVE_SINCE,
    liveConfigVersion: 8,
    ...over,
  };
}

const props = { symbol: 'BTCUSDT', interval: '1h', style: 'day_trading' as const, eligible: true, barsLoading: false, barsError: false, inView: null };

beforeEach(() => {
  query.refetch.mockReset();
  query.state = { isPending: false, isError: false, error: null, data: available() };
});

describe('TrackRecordPanel', () => {
  it('leads with the answer: right-rate against the coin flip and break-even, then the money', () => {
    render(<TrackRecordPanel {...props} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Track record · BTCUSDT · Day trading · 1h');
    const answer = screen.getByTestId('track-record-answer');
    expect(answer).toHaveTextContent(
      'Right 44.4% of the time. A coin flip is right 50%. Breaking even after 0.16% costs needed about 51.8%.'
    );
    expect(answer).toHaveTextContent('Acting on every call lost 0.24% per call on average after costs.');
    expect(screen.queryByText(/Too few calls to judge/)).toBeNull();
  });

  it('names the span, the version, the horizon and where the live record takes over', () => {
    render(<TrackRecordPanel {...props} />);
    expect(
      screen.getByText(/Year figures: the version 8 scorer re-run over 1 Oct 2025 to 8 Oct 2026, each call judged 24 bars later\./)
    ).toBeInTheDocument();
    expect(screen.getByText(/the live record takes over at 1 Oct 2026/)).toBeInTheDocument();
  });

  it('shows the figures with buy and sell split and the net interval', () => {
    render(<TrackRecordPanel {...props} />);
    const figures = screen.getByText('Calls in the year').closest('dl') as HTMLElement;
    expect(within(figures).getByText('1,902')).toBeInTheDocument();
    expect(within(figures).getByText('45.1%')).toBeInTheDocument();
    expect(within(figures).getByText('43.7%')).toBeInTheDocument();
    expect(within(figures).getByText('40.4%')).toBeInTheDocument();
    expect(within(figures).getByText('-0.24%')).toHaveClass('text-bearish');
    expect(figures).toHaveTextContent('95% range -0.54% to +0.04%');
  });

  it('compares with all ten symbols and with the live record', () => {
    render(<TrackRecordPanel {...props} />);
    expect(screen.getByText(/All ten symbols, same year:/)).toHaveTextContent(
      'All ten symbols, same year: no detectable edge. Buy and sell calls weighted equally, right 44.1% (99.17% range 38.7% to 49.5%), average after costs -0.24%.'
    );
    expect(screen.getByTestId('track-record-live')).toHaveTextContent(
      'Live record since 1 Oct 2026: 120 resolved calls, right 45.0%, average after costs -0.19%, 7 still open.'
    );
  });

  it('says which side of the live record is too thin to judge', () => {
    const base = available() as Extract<TrackRecordResponse, { available: true }>;
    query.state.data = available({ live: { ...base.live, measures: { ...base.live.measures, buyN: 12, sellN: 108 } } });
    render(<TrackRecordPanel {...props} />);
    expect(screen.getByTestId('track-record-live')).toHaveTextContent(
      'Too few to judge yet (12 buy, 108 sell, the research needs 30 a side).'
    );
  });

  it('tallies the visible window and warns that it is noise', () => {
    render(<TrackRecordPanel {...props} inView={{ calls: 12, right: 5, won: 3, cost: 2, wrong: 7, pending: 1 }} />);
    expect(screen.getByTestId('track-record-in-view')).toHaveTextContent(
      'On the chart now: 12 calls, 5 right, 3 won after costs, 1 pending. A short window is mostly noise.'
    );
  });

  it('flags a year too thin to judge', () => {
    query.state.data = available({
      symbol: { ...(available() as Extract<TrackRecordResponse, { available: true }>).symbol!, measures: { ...btcMeasures, buyN: 2, sellN: 11 } },
    });
    render(<TrackRecordPanel {...props} />);
    expect(screen.getByText(/Too few calls to judge/)).toHaveTextContent(
      'Too few calls to judge: 2 buy and 11 sell calls, under the 30 a side the research requires.'
    );
  });

  it('warns when the live scorer has moved past the re-scored version', () => {
    query.state.data = available({ liveConfigVersion: 9 });
    render(<TrackRecordPanel {...props} />);
    expect(screen.getByRole('note')).toHaveTextContent(
      'The live scorer is now version 9. This re-score describes version 8, so it no longer describes the live signal.'
    );
  });

  it('keeps the method and provenance one disclosure away', () => {
    render(<TrackRecordPanel {...props} />);
    const summary = screen.getByText('How this was measured');
    const details = summary.closest('details') as HTMLElement;
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('never enter the live record, the calibration or the paper desk');
    expect(details).toHaveTextContent('the tiers agree on 99.9% of 1,740 bars');
    expect(details).toHaveTextContent('Rows file 2addedf2b2ce, report 2e19b91553c0, commit 663e4a1');
  });

  it('explains the marks the chart draws', () => {
    render(<TrackRecordPanel {...props} />);
    const legend = screen.getByTestId('call-legend');
    for (const text of ['won after costs', 'right, but costs ate it', 'wrong way', 'outcome pending']) {
      expect(within(legend).getByText(text)).toBeInTheDocument();
    }
    expect(legend).toHaveTextContent('The dashed line splits re-scored calls (left) from the live record (right).');
  });

  it('reports the chart marks loading or failing', () => {
    const { rerender } = render(<TrackRecordPanel {...props} barsLoading />);
    expect(screen.getByText('Loading past calls for the chart.')).toBeInTheDocument();
    rerender(<TrackRecordPanel {...props} barsError />);
    expect(screen.getByText(/Past calls could not be loaded/)).toBeInTheDocument();
  });

  it('has loading, error with retry, no-run and ineligible states', () => {
    query.state = { isPending: true, isError: false, error: null, data: undefined };
    const { rerender } = render(<TrackRecordPanel {...props} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading the track record.');

    query.state = { isPending: false, isError: true, error: new Error('Request failed with status 500'), data: undefined };
    rerender(<TrackRecordPanel {...props} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the track record. Request failed with status 500');
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    expect(query.refetch).toHaveBeenCalled();

    query.state = { isPending: false, isError: false, error: null, data: { available: false, reason: 'no-run' } };
    rerender(<TrackRecordPanel {...props} />);
    expect(screen.getByText(/not loaded on this server yet/)).toBeInTheDocument();

    rerender(<TrackRecordPanel {...props} interval="1m" style="scalping" eligible={false} />);
    expect(screen.getByText('No track record for BTCUSDT at 1m. The re-score covers the ten signal symbols at 5m, 15m, 1h, 4h and 1d.')).toBeInTheDocument();
  });
});

describe('HitRateRuler', () => {
  it('hugs the marks with a padded domain in tenths', () => {
    expect(rulerDomain([0.5, 0.4443, 0.3845, 0.5025, 0.5178])).toEqual({ min: 0.3, max: 0.6 });
    expect(rulerDomain([0.5, 0.97])).toEqual({ min: 0.4, max: 1 });
  });

  it('labels the measured rate, the coin flip and the break-even, and summarises them for screen readers', () => {
    render(<HitRateRuler right={0.4443} interval={{ lo: 0.3845, hi: 0.5025 }} breakEven={0.5178} />);
    const ruler = screen.getByTestId('hit-rate-ruler');
    expect(ruler).toHaveTextContent('Right 44.4%');
    expect(ruler).toHaveTextContent('Coin flip 50%');
    expect(ruler).toHaveTextContent('Break-even 51.8%');
    expect(ruler.querySelector('figcaption')).toHaveTextContent(
      'Right 44.4% (95% range 38.5% to 50.2%), coin flip 50%, break-even 51.8%.'
    );
  });

  it('omits an unreachable break-even mark', () => {
    render(<HitRateRuler right={0.6} interval={null} breakEven={1.3} />);
    expect(screen.getByTestId('hit-rate-ruler')).not.toHaveTextContent('Break-even');
  });
});

describe('MonthBars', () => {
  it('counts months below zero and offers the same figures as a table', () => {
    render(
      <MonthBars
        months={[
          { month: '2025-10', calls: 160, right: 0.41, bh: 0.41, net: -0.31 },
          { month: '2025-11', calls: 150, right: 0.52, bh: 0.52, net: 0.12 },
          { month: '2025-12', calls: 0, right: null, bh: null, net: null },
        ]}
      />
    );
    expect(screen.getByText('1 of 2 months with calls were below zero.')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '1 of 2 months below zero after costs');
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('Oct 2025160');
    expect(within(rows[1]).getByText('-0.31%')).toHaveClass('text-bearish');
    expect(within(rows[3]).getAllByText('n/a')).toHaveLength(2);
  });
});
