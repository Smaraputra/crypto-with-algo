'use client';

import { Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ExportButton } from './ExportButton';
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

  const activeFilterCount = Object.entries(filters).filter(
    ([key, val]) => val && key !== 'page' && key !== 'limit' && key !== 'sort'
  ).length;

  function setFilter(key: keyof JournalFilters, value: string | undefined) {
    onChange({ ...filters, [key]: value, page: 1 });
  }

  function clearFilters() {
    onChange({ page: 1 });
  }

  return (
    <div className="flex items-center gap-2" data-testid="journal-filter-bar">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            data-testid="filter-trigger"
          >
            <Filter className="size-3" />
            Filters
            {activeFilterCount > 0 && (
              <Badge
                variant="secondary"
                className="ml-1 h-4 min-w-4 px-1 text-xs rounded-full"
                data-testid="active-filter-count"
              >
                {activeFilterCount}
              </Badge>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3" align="start">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Filters</span>
              {activeFilterCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 text-xs px-1.5"
                  onClick={clearFilters}
                  data-testid="clear-all-filters"
                >
                  Clear all
                </Button>
              )}
            </div>

            {/* Symbol filter */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground uppercase tracking-wider">
                Symbol
              </label>
              <Select
                value={filters.symbol || '_all'}
                onValueChange={(v) => setFilter('symbol', v === '_all' ? undefined : v)}
              >
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue placeholder="All Symbols" />
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
            </div>

            {/* Action filter */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground uppercase tracking-wider">
                Action
              </label>
              <Select
                value={filters.action || '_all'}
                onValueChange={(v) => setFilter('action', v === '_all' ? undefined : v)}
              >
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue placeholder="All Actions" />
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
            </div>

            {/* Tag filter */}
            {tags.length > 0 && (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">
                  Tag
                </label>
                <Select
                  value={filters.tag || '_all'}
                  onValueChange={(v) => setFilter('tag', v === '_all' ? undefined : v)}
                >
                  <SelectTrigger className="h-7 text-xs">
                    <SelectValue placeholder="All Tags" />
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
              </div>
            )}

            {/* Market Condition filter */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground uppercase tracking-wider">
                Market Condition
              </label>
              <Select
                value={filters.marketCondition || '_all'}
                onValueChange={(v) =>
                  setFilter('marketCondition', v === '_all' ? undefined : v)
                }
              >
                <SelectTrigger className="h-7 text-xs">
                  <SelectValue placeholder="All Conditions" />
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
            </div>

            {/* Date range */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">
                  From
                </label>
                <Input
                  type="date"
                  value={filters.startDate || ''}
                  onChange={(e) => setFilter('startDate', e.target.value || undefined)}
                  className="h-7 text-xs"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground uppercase tracking-wider">
                  To
                </label>
                <Input
                  type="date"
                  value={filters.endDate || ''}
                  onChange={(e) => setFilter('endDate', e.target.value || undefined)}
                  className="h-7 text-xs"
                />
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <ExportButton />
    </div>
  );
}
