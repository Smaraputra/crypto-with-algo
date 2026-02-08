'use client';

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { useTransactions } from '@/hooks/usePortfolio';

interface TransactionHistoryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  portfolioId: string;
  symbol: string;
}

export function TransactionHistory({
  open,
  onOpenChange,
  portfolioId,
  symbol,
}: TransactionHistoryProps) {
  const { data, isLoading } = useTransactions(portfolioId, symbol);
  const transactions = (data as { transactions?: Array<{
    _id?: string;
    type: string;
    quantity: number;
    price: number;
    date: string;
    fee?: number;
    notes?: string;
  }> })?.transactions ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Transaction History - {symbol}</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <div className="space-y-2" data-testid="tx-history-skeleton">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-8 rounded-sm animate-shimmer" />
            ))}
          </div>
        ) : transactions.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground" data-testid="tx-history-empty">
            No transactions recorded.
          </p>
        ) : (
          <div data-testid="tx-history-table">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Qty</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Fee</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {transactions.map((tx, i) => (
                  <TableRow key={tx._id ?? i}>
                    <TableCell className="font-mono tabular-nums text-xs">
                      {new Date(tx.date).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={tx.type === 'buy' ? 'default' : 'destructive'}
                        className={
                          tx.type === 'buy'
                            ? 'bg-[#0ecb81] hover:bg-[#0ecb81]/90'
                            : ''
                        }
                      >
                        {tx.type.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono tabular-nums">
                      {tx.quantity}
                    </TableCell>
                    <TableCell className="font-mono tabular-nums">
                      ${tx.price.toLocaleString()}
                    </TableCell>
                    <TableCell className="font-mono tabular-nums text-xs">
                      {tx.fee ? `$${tx.fee}` : '--'}
                    </TableCell>
                    <TableCell className="max-w-[120px] truncate text-xs text-muted-foreground">
                      {tx.notes ?? '--'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
