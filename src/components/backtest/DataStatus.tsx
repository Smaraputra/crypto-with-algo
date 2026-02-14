'use client';

import { useState, useCallback, useEffect } from 'react';
import { Database, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export interface CandleRangeInfo {
  oldest: number | null;
  newest: number | null;
  count: number;
}

interface DataStatusProps {
  symbol: string;
  interval: string;
  compact?: boolean;
  onBackfillComplete?: () => void;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function DataStatus({ symbol, interval, compact, onBackfillComplete }: DataStatusProps) {
  const [range, setRange] = useState<CandleRangeInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/candles/range?symbol=${symbol}&interval=${interval}`
      );
      if (!res.ok) throw new Error('Failed to fetch status');
      const data: CandleRangeInfo = await res.json();
      setRange(data);
    } catch {
      toast.error('Failed to check data status');
    } finally {
      setLoading(false);
    }
  }, [symbol, interval]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleBackfill = useCallback(async () => {
    setBackfilling(true);
    try {
      const res = await fetch('/api/candles/backfill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, interval, months: 24 }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Backfill failed');
      }
      const result = await res.json();
      toast.success(
        `Loaded ${result.inserted} new candles (${result.total} total)`
      );
      setRange({
        oldest: result.oldest,
        newest: result.newest,
        count: result.total,
      });
      onBackfillComplete?.();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : 'Backfill failed'
      );
    } finally {
      setBackfilling(false);
    }
  }, [symbol, interval, onBackfillComplete]);

  const content = (
    <div className="space-y-3" data-testid="data-status-content">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {symbol} / {interval}
        </span>
        {loading && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
      </div>

      {!loading && range && (
        <div className="space-y-1.5 text-xs">
          {range.count > 0 ? (
            <>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Candles stored:</span>
                <span className="font-mono tabular-nums">{range.count.toLocaleString()}</span>
              </div>
              {range.oldest && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">From:</span>
                  <span>{formatDate(range.oldest)}</span>
                </div>
              )}
              {range.newest && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">To:</span>
                  <span>{formatDate(range.newest)}</span>
                </div>
              )}
            </>
          ) : (
            <p className="text-muted-foreground">No historical data stored yet.</p>
          )}
        </div>
      )}

      {!loading && (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={handleBackfill}
          disabled={backfilling}
          data-testid="backfill-button"
        >
          {backfilling ? (
            <Loader2 className="mr-1 size-3 animate-spin" />
          ) : (
            <Download className="mr-1 size-3" />
          )}
          {backfilling ? 'Downloading...' : 'Download 2yr History'}
        </Button>
      )}
    </div>
  );

  if (compact) {
    return <div data-testid="data-status">{content}</div>;
  }

  return (
    <Card data-testid="data-status">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Database className="size-4" />
          Historical Data
        </CardTitle>
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
}
