'use client';

import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { StateNotice } from '@/components/kit/StateNotice';
import { useJournalEntries, useJournalTags, type JournalFilters } from '@/hooks/useJournal';
import { useSymbols } from '@/hooks/useSymbols';
import { SIGNAL_SYMBOLS } from '@/lib/signals/signal-symbols';
import { cn } from '@/lib/utils';
import { formatDateTime, formatHold } from '@/lib/journal/format';
import { JOURNAL_ACTIONS, type JournalEntry } from '@/types/journal';

export interface TradesViewProps {
  onSelectEntry: (entry: JournalEntry) => void;
  onOpenLogTrade: () => void;
  className?: string;
}

function formatCurrency(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) {
    return 'n/a';
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: val < 1 ? 4 : 2,
  }).format(val);
}

function formatPnl(pnl: number | null | undefined): { text: string; className: string } {
  if (pnl === null || pnl === undefined || !Number.isFinite(pnl)) {
    return { text: 'n/a', className: 'text-muted-foreground' };
  }
  if (pnl === 0) {
    return { text: '0.00%', className: 'text-foreground' };
  }
  const sign = pnl > 0 ? '+' : '';
  return {
    text: `${sign}${pnl.toFixed(2)}%`,
    className: pnl > 0 ? 'text-up' : 'text-down',
  };
}

function getBaseAsset(sym: string): string {
  return sym.replace(/(USDT|USDC|BUSD)$/, '') || sym;
}

export const TradesView: React.FC<TradesViewProps> = ({
  onSelectEntry,
  onOpenLogTrade,
  className,
}) => {
  const [coin, setCoin] = useState('');
  const [action, setAction] = useState('');
  const [tag, setTag] = useState('');
  const [status, setStatus] = useState<'open' | 'closed' | ''>('');

  const { data: symbolsData } = useSymbols();
  const { data: tagsData } = useJournalTags();

  const coinOptions = useMemo(() => {
    if (symbolsData && symbolsData.length > 0) {
      return symbolsData.map((s) => ({
        value: s.symbol,
        label: s.baseAsset || getBaseAsset(s.symbol),
      }));
    }
    return SIGNAL_SYMBOLS.map((s) => ({
      value: s,
      label: getBaseAsset(s),
    }));
  }, [symbolsData]);

  const activeFilters = useMemo<JournalFilters>(() => {
    const f: JournalFilters = {};
    if (coin) f.symbol = coin;
    if (action) f.action = action;
    if (tag) f.tag = tag;
    if (status === 'open' || status === 'closed') f.status = status;
    return f;
  }, [coin, action, tag, status]);

  const { data, isLoading, isError } = useJournalEntries(activeFilters);

  if (isLoading) {
    return <StateNotice kind="loading" title="Loading trades..." className={className} />;
  }

  if (isError) {
    return (
      <StateNotice
        kind="error"
        title="Failed to load trades."
        description="Please check your connection and try again."
        className={className}
      />
    );
  }

  const entries = data?.entries ?? [];

  if (entries.length === 0) {
    return (
      <div className={cn('space-y-6', className)}>
        {renderFilters()}
        <StateNotice
          kind="empty"
          title="No trades logged yet."
          action={
            <Button
              onClick={onOpenLogTrade}
              className="rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold min-h-[44px] px-5"
            >
              Log a trade
            </Button>
          }
        />
      </div>
    );
  }

  const openTrades = entries.filter((e) => e.exitPrice === null || e.exitPrice === undefined);
  const closedTrades = entries.filter((e) => e.exitPrice !== null && e.exitPrice !== undefined);

  function renderFilters() {
    return (
      <div className="flex flex-wrap items-end gap-3 p-4 rounded-[14px] bg-card border border-edge/30">
        <div className="flex flex-col gap-1 min-w-[130px]">
          <label htmlFor="trades-filter-coin" className="text-[13px] font-medium text-muted-foreground">
            Coin
          </label>
          <select
            id="trades-filter-coin"
            aria-label="Coin"
            value={coin}
            onChange={(e) => setCoin(e.target.value)}
            className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] cursor-pointer focus-visible:outline-3 focus-visible:outline-ring"
          >
            <option value="">All coins</option>
            {coinOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1 min-w-[120px]">
          <label htmlFor="trades-filter-action" className="text-[13px] font-medium text-muted-foreground">
            Action
          </label>
          <select
            id="trades-filter-action"
            aria-label="Action"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] cursor-pointer focus-visible:outline-3 focus-visible:outline-ring"
          >
            <option value="">All actions</option>
            {JOURNAL_ACTIONS.map((act) => (
              <option key={act} value={act}>
                {act.charAt(0).toUpperCase() + act.slice(1)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1 min-w-[120px]">
          <label htmlFor="trades-filter-tag" className="text-[13px] font-medium text-muted-foreground">
            Tag
          </label>
          <select
            id="trades-filter-tag"
            aria-label="Tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] cursor-pointer focus-visible:outline-3 focus-visible:outline-ring"
          >
            <option value="">All tags</option>
            {tagsData?.tags?.map((t) => (
              <option key={t.tag} value={t.tag}>
                {t.tag}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1 min-w-[120px]">
          <label htmlFor="trades-filter-status" className="text-[13px] font-medium text-muted-foreground">
            Status
          </label>
          <select
            id="trades-filter-status"
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as 'open' | 'closed' | '')}
            className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] cursor-pointer focus-visible:outline-3 focus-visible:outline-ring"
          >
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
          </select>
        </div>
      </div>
    );
  }

  function renderTradeTable(tradeList: JournalEntry[], isClosedList: boolean) {
    if (tradeList.length === 0) {
      return (
        <div className="rounded-[14px] bg-card p-6 border border-edge/20 text-center">
          <p className="text-[14px] text-muted-foreground">
            {isClosedList ? 'No closed trades.' : 'No open trades.'}
          </p>
        </div>
      );
    }

    return (
      <div className="overflow-x-auto rounded-[14px] border border-edge/30 bg-card">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-line text-[13px] font-medium text-muted-foreground bg-muted/20">
              <th scope="col" className="py-3.5 px-4">Coin</th>
              <th scope="col" className="py-3.5 px-4">Action</th>
              <th scope="col" className="py-3.5 px-4 text-right">Entry</th>
              {isClosedList && <th scope="col" className="py-3.5 px-4 text-right">Exit</th>}
              {isClosedList && <th scope="col" className="py-3.5 px-4 text-right">P&L</th>}
              {isClosedList && <th scope="col" className="py-3.5 px-4 text-right">Held</th>}
              <th scope="col" className="py-3.5 px-4">Tags</th>
              <th scope="col" className="py-3.5 px-4 text-right">Entered</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line text-[14px]">
            {tradeList.map((entry) => {
              const pnl = formatPnl(entry.outcomePnlPercent);
              const shotCount = entry.screenshots?.length ?? 0;
              const hold = formatHold(entry.enteredAt ?? entry.createdAt, entry.exitedAt);
              return (
                <tr
                  key={entry._id}
                  onClick={() => onSelectEntry(entry)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectEntry(entry);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Open trade entry for ${getBaseAsset(entry.symbol)}`}
                  className="hover:bg-muted/40 transition-colors cursor-pointer focus-visible:outline-3 focus-visible:outline-ring"
                >
                  <td className="py-3.5 px-4 font-semibold text-foreground">
                    <span>{getBaseAsset(entry.symbol)}</span>
                    {shotCount > 0 && (
                      <span className="ml-1.5 text-[12px] font-normal text-muted-foreground">
                        {shotCount === 1 ? '1 shot' : `${shotCount} shots`}
                      </span>
                    )}
                  </td>
                  <td className="py-3.5 px-4">
                    <span className="inline-block px-2 py-0.5 rounded-[6px] text-[12px] font-semibold bg-muted/30 text-foreground">
                      {entry.action}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-right font-sans tabular-nums text-foreground">
                    {formatCurrency(entry.entryPrice)}
                  </td>
                  {isClosedList && (
                    <td className="py-3.5 px-4 text-right font-sans tabular-nums text-foreground">
                      {formatCurrency(entry.exitPrice)}
                    </td>
                  )}
                  {isClosedList && (
                    <td className={cn('py-3.5 px-4 text-right font-sans tabular-nums font-medium', pnl.className)}>
                      {pnl.text}
                    </td>
                  )}
                  {isClosedList && (
                    <td className="py-3.5 px-4 text-right font-sans tabular-nums">
                      {hold ? (
                        <span className="text-foreground">{hold}</span>
                      ) : (
                        <span className="text-muted-foreground">n/a</span>
                      )}
                    </td>
                  )}
                  <td className="py-3.5 px-4">
                    {entry.tags && entry.tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {entry.tags.map((t) => (
                          <span
                            key={t}
                            className="inline-block px-2 py-0.5 rounded-[6px] text-[12px] bg-muted/20 text-ink-2"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-[13px]">n/a</span>
                    )}
                  </td>
                  <td className="py-3.5 px-4 text-right text-muted-foreground font-sans tabular-nums text-[13px]">
                    {formatDateTime(entry.enteredAt ?? entry.createdAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className={cn('space-y-6', className)}>
      {renderFilters()}

      <div className="space-y-3">
        <h2 className="text-[18px] font-semibold text-foreground">Open trades</h2>
        {renderTradeTable(openTrades, false)}
      </div>

      <div className="space-y-3">
        <h2 className="text-[18px] font-semibold text-foreground">Closed trades</h2>
        {renderTradeTable(closedTrades, true)}
      </div>
    </div>
  );
};
