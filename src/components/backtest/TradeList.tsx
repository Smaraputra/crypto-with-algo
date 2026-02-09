'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { BacktestTrade } from '@/lib/backtest/types';

interface TradeListProps {
  trades: BacktestTrade[];
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPrice(price: number): string {
  if (price >= 1000) return price.toFixed(2);
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

export function TradeList({ trades }: TradeListProps) {
  if (trades.length === 0) {
    return (
      <div
        className="py-8 text-center text-sm text-muted-foreground"
        data-testid="trade-list-empty"
      >
        No trades generated
      </div>
    );
  }

  return (
    <div className="overflow-x-auto" data-testid="trade-list">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs">#</TableHead>
            <TableHead className="text-xs">Entry</TableHead>
            <TableHead className="text-xs">Exit</TableHead>
            <TableHead className="text-xs">Side</TableHead>
            <TableHead className="text-right text-xs">Entry Price</TableHead>
            <TableHead className="text-right text-xs">Exit Price</TableHead>
            <TableHead className="text-right text-xs">PnL</TableHead>
            <TableHead className="text-right text-xs">PnL%</TableHead>
            <TableHead className="text-xs">Exit Reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {trades.map((trade, i) => {
            const isWin = trade.pnl > 0;
            const rowClass = isWin
              ? 'bg-bullish/5'
              : trade.pnl < 0
                ? 'bg-bearish/5'
                : '';

            return (
              <TableRow key={i} className={rowClass}>
                <TableCell className="font-mono text-xs tabular-nums">
                  {i + 1}
                </TableCell>
                <TableCell className="text-xs">
                  {formatTime(trade.entryTime)}
                </TableCell>
                <TableCell className="text-xs">
                  {formatTime(trade.exitTime)}
                </TableCell>
                <TableCell className="text-xs">
                  <span
                    className={
                      trade.side === 'long' ? 'text-bullish' : 'text-bearish'
                    }
                  >
                    {trade.side.toUpperCase()}
                  </span>
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {formatPrice(trade.entryPrice)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {formatPrice(trade.exitPrice)}
                </TableCell>
                <TableCell
                  className={`text-right font-mono text-xs tabular-nums ${
                    isWin ? 'text-bullish' : 'text-bearish'
                  }`}
                >
                  {trade.pnl >= 0 ? '+' : ''}
                  {trade.pnl.toFixed(2)}
                </TableCell>
                <TableCell
                  className={`text-right font-mono text-xs tabular-nums ${
                    isWin ? 'text-bullish' : 'text-bearish'
                  }`}
                >
                  {trade.pnlPercent >= 0 ? '+' : ''}
                  {trade.pnlPercent.toFixed(2)}%
                </TableCell>
                <TableCell className="text-xs capitalize text-muted-foreground">
                  {trade.exitReason.replace('_', ' ')}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
