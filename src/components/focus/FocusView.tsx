'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useUIStore } from '@/stores/uiStore';
import { useFocusMtf } from '@/hooks/useFocusMtf';
import { useSignalLabV4 } from '@/hooks/useSignalLabV4';
import { intervalToMs } from '@/lib/intervals';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { SymbolSearch } from '@/components/market/SymbolSearch';
import { LazyFocusChart } from './LazyFocusChart';
import { MtfStrip } from './MtfStrip';
import { BestWeHave } from './BestWeHave';
import { ScoreDirection } from './ScoreDirection';
import { LazyTradeCost } from './LazyTradeCost';
import { CoinHeadlines } from './CoinHeadlines';

export function FocusView() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const rawParam = searchParams?.get('symbol')?.toUpperCase();
  const validParam =
    rawParam && /^[A-Z0-9]{2,20}USDT$/.test(rawParam) ? rawParam : null;

  const storeSymbol = useUIStore((s) => s.selectedSymbol);
  const setSelectedSymbol = useUIStore((s) => s.setSelectedSymbol);

  const symbol = validParam ?? storeSymbol ?? 'BTCUSDT';

  const prevStoreSymbolRef = useRef(storeSymbol);

  useEffect(() => {
    if (validParam && validParam !== storeSymbol) {
      setSelectedSymbol(validParam);
      prevStoreSymbolRef.current = validParam;
    }
  }, [validParam, storeSymbol, setSelectedSymbol]);

  useEffect(() => {
    if (storeSymbol && storeSymbol !== prevStoreSymbolRef.current) {
      prevStoreSymbolRef.current = storeSymbol;
      router.replace(`/focus?symbol=${storeSymbol}`);
    }
  }, [storeSymbol, router]);

  const [focusInterval, setFocusInterval] = useState<'15m' | '1h'>('1h');
  const [showInternal, setShowInternal] = useState(false);
  const [showSma, setShowSma] = useState(false);
  const [showMacd, setShowMacd] = useState(false);

  const mtf = useFocusMtf(symbol);
  const labV4 = useSignalLabV4(symbol);
  const labMarks = useMemo(() => {
    const entries = labV4.data?.entries;
    if (!entries || entries.length === 0) return undefined;
    return entries.map((entry) => ({
      time: new Date(entry.barClose).getTime(),
      side: entry.side,
      label: entry.hypothesis.startsWith('S1') ? ('S1' as const) : ('S2' as const),
    }));
  }, [labV4.data?.entries]);
  const intervalMs = intervalToMs(focusInterval);

  return (
    <div className="space-y-4">
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold text-foreground">Focus</h1>
          <span className="font-mono font-semibold text-base">{symbol}</span>
          <span className="text-xs text-muted-foreground">USDT-M perpetual</span>
          <SymbolSearch />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={showInternal ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={showInternal}
            onClick={() => setShowInternal((prev) => !prev)}
            className="min-h-11 text-xs sm:min-h-8"
          >
            Internal structure
          </Button>
          <Button
            variant={showSma ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={showSma}
            onClick={() => setShowSma((prev) => !prev)}
            className="min-h-11 text-xs sm:min-h-8"
          >
            50 SMA
          </Button>
          <Button
            variant={showMacd ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={showMacd}
            onClick={() => setShowMacd((prev) => !prev)}
            className="min-h-11 text-xs sm:min-h-8"
          >
            MACD
          </Button>
        </div>
      </div>

      {/* Decision aid disclaimer */}
      <p className="text-xs text-muted-foreground">
        Decision aid, not a signal. Nothing here has a proven edge: each section says what stands behind it.
      </p>

      {/* Body: Chart and side rail */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-1">
          <div className="h-[560px] sm:h-[640px]">
            <LazyFocusChart
              symbol={symbol}
              interval={focusInterval}
              market="perp"
              intervalOptions={['15m', '1h']}
              onIntervalChange={(val) => {
                if (val === '15m' || val === '1h') {
                  setFocusInterval(val);
                }
              }}
              focusOverlay={{
                intervalMs,
                showInternal,
                showSma,
                showMacd,
                priorDay: mtf.data?.priorDay ?? null,
                labMarks,
              }}
            />
          </div>
          {labMarks && labMarks.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Triangles: lab-v4 entries (under test, lost on history).
            </p>
          )}
        </div>
        <div>
          <Card className="divide-y divide-border">
            <ErrorBoundary fallback={<p className="p-4 text-xs text-muted-foreground">Timeframes unavailable</p>}>
              <MtfStrip symbol={symbol} />
            </ErrorBoundary>
            <ErrorBoundary fallback={<p className="p-4 text-xs text-muted-foreground">Best we have unavailable</p>}>
              <BestWeHave symbol={symbol} />
            </ErrorBoundary>
            <ErrorBoundary fallback={<p className="p-4 text-xs text-muted-foreground">Signal score unavailable</p>}>
              <ScoreDirection symbol={symbol} interval={focusInterval} />
            </ErrorBoundary>
            <ErrorBoundary fallback={<p className="p-4 text-xs text-muted-foreground">Costs unavailable</p>}>
              <LazyTradeCost key={focusInterval} symbol={symbol} interval={focusInterval} />
            </ErrorBoundary>
            <ErrorBoundary fallback={<p className="p-4 text-xs text-muted-foreground">Headlines unavailable</p>}>
              <CoinHeadlines symbol={symbol} />
            </ErrorBoundary>
          </Card>
        </div>
      </div>
    </div>
  );
}
