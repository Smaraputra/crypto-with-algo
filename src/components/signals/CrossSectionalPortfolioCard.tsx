'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCrossSectionalLatest } from '@/hooks/useSignals';
import { cn } from '@/lib/utils';

export function CrossSectionalPortfolioCard() {
  const { data, isLoading } = useCrossSectionalLatest();
  const [showRankings, setShowRankings] = useState(false);

  if (isLoading) {
    return (
      <Card className="border-border">
        <CardHeader>
          <div className="h-6 w-64 rounded bg-muted animate-shimmer" />
        </CardHeader>
        <CardContent>
          <div className="h-32 w-full rounded bg-muted animate-shimmer" />
        </CardContent>
      </Card>
    );
  }

  const signal = data?.signal;
  const book = data?.book;

  if (!signal) {
    return (
      <Card className="border-border">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base font-semibold">
              8-Hour Cross-Sectional Relative Value Portfolio
            </CardTitle>
            <Badge variant="outline" className="border-primary/40 text-primary text-xs">
              Beta-Neutral | Buffer 2
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Awaiting first 8-hour settlement cycle snapshot (00:00, 08:00, 16:00 UTC).
          </p>
        </CardHeader>
      </Card>
    );
  }

  const makerEquity = book?.equityMaker ?? 10000;
  const takerEquity = book?.equityTaker ?? 10000;
  const startEquity = book?.startEquity ?? 10000;
  const makerReturnPct = ((makerEquity - startEquity) / startEquity) * 100;
  const takerReturnPct = ((takerEquity - startEquity) / startEquity) * 100;
  const activeTargets = signal.targets.filter((t) => t.side !== 'flat');

  // Map latest close prices from snapshots
  const snapshotMap = new Map(signal.snapshots.map((s) => [s.symbol, s]));

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base font-semibold">
              8-Hour Cross-Sectional Relative Value Portfolio
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Top 10 Perpetual Universe | Rebalances at 00:00, 08:00, 16:00 UTC
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs font-mono tabular-nums">
              Net Beta: {signal.netBetaExposure.toFixed(2)}
            </Badge>
            <Badge variant="outline" className="text-xs font-mono tabular-nums">
              Gross: {signal.grossExposure.toFixed(1)}x
            </Badge>
            <Badge className="bg-primary/20 text-primary border border-primary/40 text-xs">
              Buffer: 2
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Equity Metrics Overview */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded border border-border p-2.5">
            <p className="text-[11px] text-muted-foreground">Maker Track (1.8 bps)</p>
            <p className="text-sm font-semibold font-mono tabular-nums mt-0.5">
              ${makerEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <p
              className={cn(
                'text-[10px] font-mono tabular-nums',
                makerReturnPct >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'
              )}
            >
              {makerReturnPct >= 0 ? '+' : ''}
              {makerReturnPct.toFixed(2)}%
            </p>
          </div>

          <div className="rounded border border-border p-2.5">
            <p className="text-[11px] text-muted-foreground">Taker Track (7.0 bps)</p>
            <p className="text-sm font-semibold font-mono tabular-nums mt-0.5">
              ${takerEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
            <p
              className={cn(
                'text-[10px] font-mono tabular-nums',
                takerReturnPct >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'
              )}
            >
              {takerReturnPct >= 0 ? '+' : ''}
              {takerReturnPct.toFixed(2)}%
            </p>
          </div>

          <div className="rounded border border-border p-2.5">
            <p className="text-[11px] text-muted-foreground">Funding Collected</p>
            <p
              className={cn(
                'text-sm font-semibold font-mono tabular-nums mt-0.5',
                (book?.totalFundingCollected ?? 0) >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'
              )}
            >
              {(book?.totalFundingCollected ?? 0) >= 0 ? '+' : ''}
              {(book?.totalFundingCollected ?? 0).toFixed(2)} USDT
            </p>
            <p className="text-[10px] text-muted-foreground">8h Settlements</p>
          </div>

          <div className="rounded border border-border p-2.5">
            <p className="text-[11px] text-muted-foreground">Portfolio Turnover</p>
            <p className="text-sm font-semibold font-mono tabular-nums mt-0.5">
              {(book?.totalTurnover ?? 0).toFixed(2)}x
            </p>
            <p className="text-[10px] text-muted-foreground">Hysteresis Dampened</p>
          </div>
        </div>

        {/* Active Concurrent Legs */}
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wider">
            Active Allocations (2 Longs, 2 Shorts)
          </h3>
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-left text-xs">
              <thead className="bg-muted/50 border-b border-border text-muted-foreground">
                <tr>
                  <th className="py-2 px-3 font-medium">Side</th>
                  <th className="py-2 px-3 font-medium">Symbol</th>
                  <th className="py-2 px-3 font-medium text-right">Target Weight</th>
                  <th className="py-2 px-3 font-medium text-right">Mark Price</th>
                  <th className="py-2 px-3 font-medium text-right">Funding Rate</th>
                  <th className="py-2 px-3 font-medium text-right">Beta (BTC)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {activeTargets.map((target) => {
                  const snap = snapshotMap.get(target.symbol);
                  const isLong = target.side === 'long';
                  return (
                    <tr key={target.symbol} className="hover:bg-muted/20">
                      <td className="py-2 px-3">
                        <span
                          className={cn(
                            'inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase',
                            isLong
                              ? 'bg-[#0ecb81]/15 text-[#0ecb81]'
                              : 'bg-[#f6465d]/15 text-[#f6465d]'
                          )}
                        >
                          {target.side}
                        </span>
                      </td>
                      <td className="py-2 px-3 font-medium">{target.symbol}</td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">
                        {target.weight > 0 ? '+' : ''}
                        {(target.weight * 100).toFixed(2)}%
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">
                        {snap && snap.close != null ? `$${snap.close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : '-'}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">
                        {snap && snap.fundingRate != null ? `${(snap.fundingRate * 100).toFixed(4)}%` : '-'}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">
                        {snap && snap.betaToBtc != null ? snap.betaToBtc.toFixed(2) : '1.00'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Collapsible Factor Rankings Table */}
        <div className="pt-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowRankings((prev) => !prev)}
            className="text-xs text-muted-foreground hover:text-foreground h-7 px-2"
          >
            {showRankings ? 'Hide Factor Rankings' : 'Show Full Cross-Sectional Factor Rankings (10 Symbols)'}
          </Button>

          {showRankings && (
            <div className="mt-2 overflow-x-auto rounded border border-border">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/50 border-b border-border text-muted-foreground">
                  <tr>
                    <th className="py-2 px-3 font-medium">Rank</th>
                    <th className="py-2 px-3 font-medium">Symbol</th>
                    <th className="py-2 px-3 font-medium text-right">Composite Z</th>
                    <th className="py-2 px-3 font-medium text-right">Momentum (30%)</th>
                    <th className="py-2 px-3 font-medium text-right">Idio Mom (25%)</th>
                    <th className="py-2 px-3 font-medium text-right">Carry (30%)</th>
                    <th className="py-2 px-3 font-medium text-right">Flow (15%)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {signal.ranks.map((r) => (
                    <tr key={r.symbol} className="hover:bg-muted/20">
                      <td className="py-2 px-3 font-mono font-semibold">#{r.rank}</td>
                      <td className="py-2 px-3 font-medium">{r.symbol}</td>
                      <td
                        className={cn(
                          'py-2 px-3 text-right font-mono tabular-nums font-semibold',
                          r.compositeZ >= 0 ? 'text-[#0ecb81]' : 'text-[#f6465d]'
                        )}
                      >
                        {r.compositeZ >= 0 ? '+' : ''}
                        {r.compositeZ.toFixed(3)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">
                        {r.zMom >= 0 ? '+' : ''}
                        {r.zMom.toFixed(3)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">
                        {r.zIdio >= 0 ? '+' : ''}
                        {r.zIdio.toFixed(3)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">
                        {r.zCarry >= 0 ? '+' : ''}
                        {r.zCarry.toFixed(3)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono tabular-nums">
                        {r.zFlow >= 0 ? '+' : ''}
                        {r.zFlow.toFixed(3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
