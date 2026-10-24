import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TradesView } from './TradesView';
import * as journalHooks from '@/hooks/useJournal';
import * as symbolsHooks from '@/hooks/useSymbols';
import type { JournalEntry } from '@/types/journal';

vi.mock('@/hooks/useJournal', () => ({
  useJournalEntries: vi.fn(),
  useJournalTags: vi.fn(),
}));

vi.mock('@/hooks/useSymbols', () => ({
  useSymbols: vi.fn(),
}));

const mockOpenTrade: JournalEntry = {
  _id: 'entry-1',
  userId: 'user-1',
  symbol: 'BTCUSDT',
  interval: '1h',
  signalScore: 20,
  signalTier: 'buy',
  action: 'buy',
  entryPrice: 65000,
  exitPrice: null,
  outcomePnlPercent: null,
  notes: 'Long breakout',
  reviewedAt: null,
  tags: ['breakout', 'trend'],
  indicatorSnapshot: null,
  strategyId: null,
  backtestResultId: null,
  lessonsLearned: '',
  reviewHistory: [],
  setupType: 'trend_continuation',
  marketCondition: 'trending_up',
  emotion: 'confident',
  mistakes: [],
  convictionLevel: 4,
  plannedRiskReward: 2.5,
  sentiment: null,
  enteredAt: '2026-10-20T10:00:00.000Z',
  createdAt: '2026-10-20T10:00:00.000Z',
  updatedAt: '2026-10-20T10:00:00.000Z',
};

const mockClosedTrade: JournalEntry = {
  _id: 'entry-2',
  userId: 'user-1',
  symbol: 'ETHUSDT',
  interval: '1h',
  signalScore: -10,
  signalTier: 'sell',
  action: 'sell',
  entryPrice: 3500,
  exitPrice: 3300,
  outcomePnlPercent: 5.71,
  notes: 'Short at resistance',
  reviewedAt: new Date('2026-10-21T12:00:00.000Z'),
  tags: ['reversal'],
  indicatorSnapshot: null,
  strategyId: null,
  backtestResultId: null,
  lessonsLearned: 'Good timing on exit',
  reviewHistory: [],
  setupType: 'reversal',
  marketCondition: 'ranging',
  emotion: 'calm',
  mistakes: [],
  convictionLevel: 3,
  plannedRiskReward: 2.0,
  sentiment: null,
  enteredAt: '2026-10-19T08:00:00.000Z',
  exitedAt: '2026-10-19T10:00:00.000Z',
  createdAt: '2026-10-19T08:00:00.000Z',
  updatedAt: '2026-10-21T12:00:00.000Z',
  screenshots: [
    { fileId: 's1', contentType: 'image/png', size: 100, uploadedAt: '' },
    { fileId: 's2', contentType: 'image/png', size: 100, uploadedAt: '' },
  ],
};

describe('TradesView', () => {
  const onSelectEntry = vi.fn();
  const onOpenLogTrade = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(symbolsHooks.useSymbols).mockReturnValue({
      data: [
        { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
        { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT' },
      ],
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof symbolsHooks.useSymbols>);

    vi.mocked(journalHooks.useJournalTags).mockReturnValue({
      data: {
        tags: [
          { tag: 'breakout', count: 3 },
          { tag: 'reversal', count: 2 },
        ],
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof journalHooks.useJournalTags>);
  });

  it('renders loading state', () => {
    vi.mocked(journalHooks.useJournalEntries).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof journalHooks.useJournalEntries>);

    render(<TradesView onSelectEntry={onSelectEntry} onOpenLogTrade={onOpenLogTrade} />);
    expect(screen.getByText('Loading trades...')).toBeInTheDocument();
  });

  it('renders error state', () => {
    vi.mocked(journalHooks.useJournalEntries).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof journalHooks.useJournalEntries>);

    render(<TradesView onSelectEntry={onSelectEntry} onOpenLogTrade={onOpenLogTrade} />);
    expect(screen.getByText('Failed to load trades.')).toBeInTheDocument();
  });

  it('renders empty state with log a trade button', () => {
    vi.mocked(journalHooks.useJournalEntries).mockReturnValue({
      data: { entries: [] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof journalHooks.useJournalEntries>);

    render(<TradesView onSelectEntry={onSelectEntry} onOpenLogTrade={onOpenLogTrade} />);
    expect(screen.getByText('No trades logged yet.')).toBeInTheDocument();

    const logButton = screen.getByRole('button', { name: 'Log a trade' });
    fireEvent.click(logButton);
    expect(onOpenLogTrade).toHaveBeenCalledTimes(1);
  });

  it('splits open and closed trades into separate lists', () => {
    vi.mocked(journalHooks.useJournalEntries).mockReturnValue({
      data: { entries: [mockOpenTrade, mockClosedTrade] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof journalHooks.useJournalEntries>);

    render(<TradesView onSelectEntry={onSelectEntry} onOpenLogTrade={onOpenLogTrade} />);

    expect(screen.getByRole('heading', { name: 'Open trades' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Closed trades' })).toBeInTheDocument();

    expect(screen.getByRole('cell', { name: 'BTC' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: /ETH[\s\S]*2 shots/ })).toBeInTheDocument();
    expect(screen.getByText('+5.71%')).toBeInTheDocument();
  });

  it('renders Entered column header and Held column in closed list', () => {
    vi.mocked(journalHooks.useJournalEntries).mockReturnValue({
      data: { entries: [mockOpenTrade, mockClosedTrade] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof journalHooks.useJournalEntries>);

    render(<TradesView onSelectEntry={onSelectEntry} onOpenLogTrade={onOpenLogTrade} />);

    // Table column headers
    const enteredHeaders = screen.getAllByRole('columnheader', { name: 'Entered' });
    expect(enteredHeaders.length).toBeGreaterThanOrEqual(1);

    const heldHeader = screen.getByRole('columnheader', { name: 'Held' });
    expect(heldHeader).toBeInTheDocument();

    // Held value "2h" for 08:00 to 10:00
    expect(screen.getByRole('cell', { name: '2h' })).toBeInTheDocument();

    // Screenshots badge "2 shots"
    expect(screen.getByText('2 shots')).toBeInTheDocument();
  });

  it('says "1 shot" for a single screenshot', () => {
    const oneShot = {
      ...mockClosedTrade,
      screenshots: [mockClosedTrade.screenshots![0]],
    };
    vi.mocked(journalHooks.useJournalEntries).mockReturnValue({
      data: { entries: [oneShot] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof journalHooks.useJournalEntries>);

    render(<TradesView onSelectEntry={onSelectEntry} onOpenLogTrade={onOpenLogTrade} />);

    expect(screen.getByText('1 shot')).toBeInTheDocument();
    expect(screen.queryByText('1 shots')).not.toBeInTheDocument();
  });

  it('clicking a row calls onSelectEntry to open the sheet', () => {
    vi.mocked(journalHooks.useJournalEntries).mockReturnValue({
      data: { entries: [mockOpenTrade, mockClosedTrade] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof journalHooks.useJournalEntries>);

    render(<TradesView onSelectEntry={onSelectEntry} onOpenLogTrade={onOpenLogTrade} />);

    const openTradeRow = screen.getByRole('button', { name: /Open trade entry for BTC/i });
    fireEvent.click(openTradeRow);

    expect(onSelectEntry).toHaveBeenCalledTimes(1);
    expect(onSelectEntry).toHaveBeenCalledWith(mockOpenTrade);
  });

  it('passes selected filters to useJournalEntries', () => {
    vi.mocked(journalHooks.useJournalEntries).mockReturnValue({
      data: { entries: [mockOpenTrade] },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof journalHooks.useJournalEntries>);

    render(<TradesView onSelectEntry={onSelectEntry} onOpenLogTrade={onOpenLogTrade} />);

    // Change coin filter
    const coinSelect = screen.getByLabelText('Coin');
    fireEvent.change(coinSelect, { target: { value: 'BTCUSDT' } });

    // Change action filter
    const actionSelect = screen.getByLabelText('Action');
    fireEvent.change(actionSelect, { target: { value: 'buy' } });

    // Change tag filter
    const tagSelect = screen.getByLabelText('Tag');
    fireEvent.change(tagSelect, { target: { value: 'breakout' } });

    // Change status filter
    const statusSelect = screen.getByLabelText('Status');
    fireEvent.change(statusSelect, { target: { value: 'open' } });

    expect(journalHooks.useJournalEntries).toHaveBeenLastCalledWith({
      symbol: 'BTCUSDT',
      action: 'buy',
      tag: 'breakout',
      status: 'open',
    });
  });
});
