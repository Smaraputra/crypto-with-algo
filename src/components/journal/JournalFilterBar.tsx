'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { X } from 'lucide-react';
import { useJournalTags, type JournalFilters } from '@/hooks/useJournal';
import { JOURNAL_ACTIONS, MARKET_CONDITIONS } from '@/types/journal';

interface JournalFilterBarProps {
  filters: JournalFilters;
  onChange: (filters: JournalFilters) => void;
}

const MARKET_CONDITION_LABELS: Record<string, string> = {
  trending_up: 'Trending Up',
  trending_down: 'Trending Down',
  ranging: 'Ranging',
  volatile: 'Volatile',
  calm: 'Calm',
};

const COMMON_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];

export function JournalFilterBar({ filters, onChange }: JournalFilterBarProps) {
  const { data: tagsData } = useJournalTags();
  const tags = tagsData?.tags ?? [];

  const activeFilters = Object.entries(filters).filter(
    ([key, val]) => val && key !== 'page' && key !== 'limit' && key !== 'sort'
  );

  function setFilter(key: keyof JournalFilters, value: string | undefined) {
    onChange({ ...filters, [key]: value, page: 1 });
  }

  function clearFilters() {
    onChange({ page: 1 });
  }

  return (
    <div className="space-y-2" data-testid="journal-filter-bar">
      <div className="flex flex-wrap gap-2">
        {/* Symbol filter */}
        <Select
          value={filters.symbol || '_all'}
          onValueChange={(v) => setFilter('symbol', v === '_all' ? undefined : v)}
        >
          <SelectTrigger className="h-7 w-28 text-xs">
            <SelectValue placeholder="Symbol" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all" className="text-xs">All Symbols</SelectItem>
            {COMMON_SYMBOLS.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">
                {s.replace('USDT', '')}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Action filter */}
        <Select
          value={filters.action || '_all'}
          onValueChange={(v) => setFilter('action', v === '_all' ? undefined : v)}
        >
          <SelectTrigger className="h-7 w-24 text-xs">
            <SelectValue placeholder="Action" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all" className="text-xs">All Actions</SelectItem>
            {JOURNAL_ACTIONS.map((a) => (
              <SelectItem key={a} value={a} className="text-xs capitalize">
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Tag filter */}
        {tags.length > 0 && (
          <Select
            value={filters.tag || '_all'}
            onValueChange={(v) => setFilter('tag', v === '_all' ? undefined : v)}
          >
            <SelectTrigger className="h-7 w-28 text-xs">
              <SelectValue placeholder="Tag" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_all" className="text-xs">All Tags</SelectItem>
              {tags.map((t) => (
                <SelectItem key={t.tag} value={t.tag} className="text-xs">
                  {t.tag} ({t.count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Market Condition filter */}
        <Select
          value={filters.marketCondition || '_all'}
          onValueChange={(v) =>
            setFilter('marketCondition', v === '_all' ? undefined : v)
          }
        >
          <SelectTrigger className="h-7 w-32 text-xs">
            <SelectValue placeholder="Condition" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all" className="text-xs">All Conditions</SelectItem>
            {MARKET_CONDITIONS.map((mc) => (
              <SelectItem key={mc} value={mc} className="text-xs">
                {MARKET_CONDITION_LABELS[mc]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Date range */}
        <Input
          type="date"
          value={filters.startDate || ''}
          onChange={(e) => setFilter('startDate', e.target.value || undefined)}
          className="h-7 w-32 text-xs"
          placeholder="Start date"
        />
        <Input
          type="date"
          value={filters.endDate || ''}
          onChange={(e) => setFilter('endDate', e.target.value || undefined)}
          className="h-7 w-32 text-xs"
          placeholder="End date"
        />
      </div>

      {/* Active filter badges */}
      {activeFilters.length > 0 && (
        <div className="flex items-center gap-1">
          {activeFilters.map(([key, val]) => (
            <Badge key={key} variant="secondary" className="text-[10px] gap-1 pr-1">
              {key}: {val}
              <button
                type="button"
                onClick={() => setFilter(key as keyof JournalFilters, undefined)}
                className="ml-0.5 hover:text-destructive"
                aria-label={`Clear ${key} filter`}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
          <Button
            variant="ghost"
            size="sm"
            className="h-5 text-[10px] px-1.5"
            onClick={clearFilters}
          >
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
}
