'use client';

import { useCallback, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Button } from '@/components/ui/button';
import { PortfolioSelector } from '@/components/portfolio/PortfolioSelector';
import { PortfolioSummary } from '@/components/portfolio/PortfolioSummary';
import { HoldingsList } from '@/components/portfolio/HoldingsList';
import { TransactionForm } from '@/components/portfolio/TransactionForm';
import { usePortfolios } from '@/hooks/usePortfolio';

export default function PortfolioPage() {
  const { data } = usePortfolios();
  const [userSelectedId, setUserSelectedId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formMode, setFormMode] = useState<'add-holding' | 'record-transaction'>('add-holding');
  const [formSymbol, setFormSymbol] = useState<string | undefined>();
  const [formBaseAsset, setFormBaseAsset] = useState<string | undefined>();
  const [formQuoteAsset, setFormQuoteAsset] = useState<string | undefined>();

  const selectedId = useMemo(() => {
    if (userSelectedId) return userSelectedId;
    return data?.portfolios?.[0]?._id ?? null;
  }, [userSelectedId, data]);

  const handleAddHolding = useCallback(() => {
    setFormMode('add-holding');
    setFormSymbol(undefined);
    setFormBaseAsset(undefined);
    setFormQuoteAsset(undefined);
    setFormOpen(true);
  }, []);

  const handleRecordTransaction = useCallback((symbol: string) => {
    setFormMode('record-transaction');
    setFormSymbol(symbol);
    const parts = symbol.replace('USDT', '');
    setFormBaseAsset(parts);
    setFormQuoteAsset('USDT');
    setFormOpen(true);
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-foreground">Portfolio</h1>
        <div className="flex items-center gap-2">
          {selectedId && (
            <Button size="sm" onClick={handleAddHolding} data-testid="add-holding-btn">
              <Plus className="mr-1 size-4" />
              Add Holding
            </Button>
          )}
          <PortfolioSelector selectedId={selectedId} onSelect={setUserSelectedId} />
        </div>
      </div>
      <ErrorBoundary
        fallback={
          <p className="text-sm text-muted-foreground">
            Portfolio summary unavailable
          </p>
        }
      >
        <PortfolioSummary portfolioId={selectedId} />
      </ErrorBoundary>
      <ErrorBoundary
        fallback={
          <p className="text-sm text-muted-foreground">
            Holdings list unavailable
          </p>
        }
      >
        <HoldingsList
          portfolioId={selectedId}
          onRecordTransaction={handleRecordTransaction}
        />
      </ErrorBoundary>
      {selectedId && (
        <TransactionForm
          open={formOpen}
          onOpenChange={setFormOpen}
          mode={formMode}
          portfolioId={selectedId}
          symbol={formSymbol}
          baseAsset={formBaseAsset}
          quoteAsset={formQuoteAsset}
        />
      )}
    </div>
  );
}
