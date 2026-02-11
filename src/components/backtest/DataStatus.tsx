'use client';

import { useState, useCallback } from 'react';
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
  onBackfillComplete?: () => void;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function DataStatus({ symbol, interval, onBackfillComplete }: DataStatusProps) {
  const [range, setRange] = useState<CandleRangeInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [fetched, setFetched] = useState(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/candles?symbol=${symbol}&interval=${interval}&limit=1`
      );
      if (!res.ok) throw new Error('Failed to fetch status');
      const data = await res.json();

      // Use a separate endpoint to get the range info -- piggyback on a minimal query
      // For count/range, we need a small trick: fetch 1 candle to see if data exists,
      // then use the count from response
      setRange({
        oldest: data.candles.length > 0 ? data.candles[0].timestamp : null,
        newest: null,
        count: data.count,
      });

      // Fetch the actual range with a large limit query for newest
      const res2 = await fetch(
        `/api/candles?symbol=${symbol}&interval=${interval}&limit=1&endTime=${Date.now()}`
      );
      if (res2.ok) {
        const data2 = await res2.json();
        if (data2.candles.length > 0) {
          setRange((prev) => prev ? {
            ...prev,
            newest: data2.candles[data2.candles.length - 1]?.timestamp ?? null,
          } : null);
        }
      }
    } catch {
      toast.error('Failed to check data status');
    } finally {
      setLoading(false);
      setFetched(true);
    }
  }, [symbol, interval]);

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

  return (
    <Card data-testid="data-status">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Database className="size-4" />
          Historical Data
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {symbol} / {interval}
          </span>
          {!fetched && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={fetchStatus}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="mr-1 size-3 animate-spin" />
              ) : null}
              Check Status
            </Button>
          )}
        </div>

        {fetched && range && (
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

        {fetched && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-full text-xs"
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
      </CardContent>
    </Card>
  );
}
