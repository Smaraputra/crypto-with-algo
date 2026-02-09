'use client';

import { Edit, Trash2 } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
const MAX_STRATEGIES_PER_USER = 5;
import type { Strategy } from '@/types/strategy';

interface StrategyListProps {
  strategies: Strategy[];
  isLoading: boolean;
  onEdit: (strategy: Strategy) => void;
  onDelete: (id: string) => void;
  deletingId: string | null;
}

export function StrategyList({
  strategies,
  isLoading,
  onEdit,
  onDelete,
  deletingId,
}: StrategyListProps) {
  if (isLoading) {
    return (
      <div className="grid gap-2 sm:grid-cols-2" data-testid="strategy-list-loading">
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  if (strategies.length === 0) {
    return (
      <div
        className="py-8 text-center text-sm text-muted-foreground"
        data-testid="strategy-list-empty"
      >
        No strategies yet. Create one to get started.
      </div>
    );
  }

  return (
    <div data-testid="strategy-list">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {strategies.length} / {MAX_STRATEGIES_PER_USER} strategies
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {strategies.map((strategy) => (
          <Card key={strategy._id} className="p-0">
            <CardContent className="flex items-start justify-between px-3 py-2.5">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">{strategy.name}</p>
                  <Badge variant={strategy.active ? 'default' : 'secondary'} className="text-[10px]">
                    {strategy.active ? 'Active' : 'Inactive'}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-1">
                  {strategy.symbols.map((s) => (
                    <span key={s} className="text-[10px] text-muted-foreground">
                      {s.replace('USDT', '')}
                    </span>
                  ))}
                  <span className="text-[10px] text-muted-foreground">|</span>
                  {strategy.intervals.map((iv) => (
                    <span key={iv} className="text-[10px] text-muted-foreground">
                      {iv}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  onClick={() => onEdit(strategy)}
                  aria-label={`Edit ${strategy.name}`}
                >
                  <Edit className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                  onClick={() => onDelete(strategy._id)}
                  disabled={deletingId === strategy._id}
                  aria-label={`Delete ${strategy.name}`}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
