'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCreateAlert } from '@/hooks/useAlerts';
import { usePortfolios, usePortfolio } from '@/hooks/usePortfolio';
import type { AlertType, CreateAlertInput } from '@/types/alert';

interface CreateAlertFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultSymbol?: string;
}

type PriceSubtype = 'price_above' | 'price_below' | 'price_change_pct';
type PortfolioSubtype =
  | 'portfolio_value_above'
  | 'portfolio_value_below'
  | 'holding_change_pct';

export function CreateAlertForm({
  open,
  onOpenChange,
  defaultSymbol,
}: CreateAlertFormProps) {
  const createAlert = useCreateAlert();
  const { data: portfoliosData } = usePortfolios();

  const [tab, setTab] = useState<'price' | 'portfolio'>('price');

  // Price alert fields
  const [symbol, setSymbol] = useState(defaultSymbol ?? '');
  const [priceSubtype, setPriceSubtype] = useState<PriceSubtype>('price_above');
  const [targetPrice, setTargetPrice] = useState('');
  const [percentChange, setPercentChange] = useState('');

  // Portfolio alert fields
  const [portfolioId, setPortfolioId] = useState('');
  const [portfolioSubtype, setPortfolioSubtype] =
    useState<PortfolioSubtype>('portfolio_value_above');
  const [portfolioThreshold, setPortfolioThreshold] = useState('');
  const [holdingSymbol, setHoldingSymbol] = useState('');
  const [holdingPercent, setHoldingPercent] = useState('');

  // Shared fields
  const [recurring, setRecurring] = useState(false);
  const [cooldownMinutes, setCooldownMinutes] = useState('60');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const { data: portfolioData } = usePortfolio(portfolioId || null);

  const resetForm = () => {
    setSymbol(defaultSymbol ?? '');
    setPriceSubtype('price_above');
    setTargetPrice('');
    setPercentChange('');
    setPortfolioId('');
    setPortfolioSubtype('portfolio_value_above');
    setPortfolioThreshold('');
    setHoldingSymbol('');
    setHoldingPercent('');
    setRecurring(false);
    setCooldownMinutes('60');
    setMessage('');
    setErrors({});
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: Record<string, string> = {};

    let alertType: AlertType;
    const input: CreateAlertInput = {} as CreateAlertInput;

    if (tab === 'price') {
      alertType = priceSubtype;
      if (!symbol.trim()) {
        newErrors.symbol = 'Symbol is required';
      }
      input.symbol = symbol.toUpperCase().trim();
      input.type = alertType;

      if (priceSubtype === 'price_change_pct') {
        const pct = parseFloat(percentChange);
        if (isNaN(pct)) {
          newErrors.percentChange = 'Percent change is required';
        }
        input.percentChange = pct;
      } else {
        const price = parseFloat(targetPrice);
        if (isNaN(price) || price <= 0) {
          newErrors.targetPrice = 'Valid target price is required';
        }
        input.targetPrice = price;
      }
    } else {
      alertType = portfolioSubtype;
      input.type = alertType;

      if (!portfolioId) {
        newErrors.portfolioId = 'Portfolio is required';
      }
      input.portfolioId = portfolioId;

      if (portfolioSubtype === 'holding_change_pct') {
        if (!holdingSymbol) {
          newErrors.holdingSymbol = 'Holding symbol is required';
        }
        const pct = parseFloat(holdingPercent);
        if (isNaN(pct)) {
          newErrors.holdingPercent = 'Percent change is required';
        }
        input.symbol = holdingSymbol;
        input.percentChange = pct;
      } else {
        const threshold = parseFloat(portfolioThreshold);
        if (isNaN(threshold) || threshold <= 0) {
          newErrors.portfolioThreshold = 'Valid threshold is required';
        }
        input.targetPrice = threshold;
      }
    }

    if (recurring) {
      input.recurring = true;
      input.cooldownMinutes = parseInt(cooldownMinutes) || 60;
    }
    if (message.trim()) {
      input.message = message.trim();
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setErrors({});
    createAlert.mutate(input, {
      onSuccess: () => {
        resetForm();
        onOpenChange(false);
      },
    });
  };

  const portfolios = portfoliosData?.portfolios ?? [];
  const holdings = portfolioData?.portfolio?.holdings ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Alert</DialogTitle>
          <DialogDescription>
            Set up a price or portfolio alert to track market conditions.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as 'price' | 'portfolio')}
          >
            <TabsList className="w-full">
              <TabsTrigger value="price" className="flex-1">
                Price Alert
              </TabsTrigger>
              <TabsTrigger value="portfolio" className="flex-1">
                Portfolio Alert
              </TabsTrigger>
            </TabsList>

            <TabsContent value="price" className="space-y-3 pt-2">
              <div className="space-y-1">
                <Label htmlFor="alert-symbol">Symbol</Label>
                <Input
                  id="alert-symbol"
                  placeholder="BTCUSDT"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
                />
                {errors.symbol && (
                  <p className="text-xs text-destructive">{errors.symbol}</p>
                )}
              </div>

              <div className="flex gap-1">
                {(
                  [
                    ['price_above', 'Above'],
                    ['price_below', 'Below'],
                    ['price_change_pct', '% Change'],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    type="button"
                    variant={priceSubtype === value ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setPriceSubtype(value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>

              {priceSubtype === 'price_change_pct' ? (
                <div className="space-y-1">
                  <Label htmlFor="percent-change">Percent Change (%)</Label>
                  <Input
                    id="percent-change"
                    type="number"
                    step="any"
                    placeholder="5"
                    value={percentChange}
                    onChange={(e) => setPercentChange(e.target.value)}
                  />
                  {errors.percentChange && (
                    <p className="text-xs text-destructive">
                      {errors.percentChange}
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-1">
                  <Label htmlFor="target-price">Target Price</Label>
                  <Input
                    id="target-price"
                    type="number"
                    step="any"
                    min="0"
                    placeholder="100000"
                    value={targetPrice}
                    onChange={(e) => setTargetPrice(e.target.value)}
                  />
                  {errors.targetPrice && (
                    <p className="text-xs text-destructive">
                      {errors.targetPrice}
                    </p>
                  )}
                </div>
              )}
            </TabsContent>

            <TabsContent value="portfolio" className="space-y-3 pt-2">
              <div className="space-y-1">
                <Label htmlFor="portfolio-select">Portfolio</Label>
                <select
                  id="portfolio-select"
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                  value={portfolioId}
                  onChange={(e) => setPortfolioId(e.target.value)}
                >
                  <option value="">Select portfolio</option>
                  {portfolios.map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {errors.portfolioId && (
                  <p className="text-xs text-destructive">
                    {errors.portfolioId}
                  </p>
                )}
              </div>

              <div className="flex gap-1">
                {(
                  [
                    ['portfolio_value_above', 'Value Above'],
                    ['portfolio_value_below', 'Value Below'],
                    ['holding_change_pct', 'Holding %'],
                  ] as const
                ).map(([value, label]) => (
                  <Button
                    key={value}
                    type="button"
                    variant={portfolioSubtype === value ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setPortfolioSubtype(value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>

              {portfolioSubtype === 'holding_change_pct' ? (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="holding-symbol">Holding</Label>
                    <select
                      id="holding-symbol"
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                      value={holdingSymbol}
                      onChange={(e) => setHoldingSymbol(e.target.value)}
                    >
                      <option value="">Select holding</option>
                      {holdings.map((h) => (
                        <option key={h.symbol} value={h.symbol}>
                          {h.symbol}
                        </option>
                      ))}
                    </select>
                    {errors.holdingSymbol && (
                      <p className="text-xs text-destructive">
                        {errors.holdingSymbol}
                      </p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="holding-percent">P&L Change (%)</Label>
                    <Input
                      id="holding-percent"
                      type="number"
                      step="any"
                      placeholder="-10"
                      value={holdingPercent}
                      onChange={(e) => setHoldingPercent(e.target.value)}
                    />
                    {errors.holdingPercent && (
                      <p className="text-xs text-destructive">
                        {errors.holdingPercent}
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <div className="space-y-1">
                  <Label htmlFor="portfolio-threshold">
                    Threshold Value (USD)
                  </Label>
                  <Input
                    id="portfolio-threshold"
                    type="number"
                    step="any"
                    min="0"
                    placeholder="50000"
                    value={portfolioThreshold}
                    onChange={(e) => setPortfolioThreshold(e.target.value)}
                  />
                  {errors.portfolioThreshold && (
                    <p className="text-xs text-destructive">
                      {errors.portfolioThreshold}
                    </p>
                  )}
                </div>
              )}
            </TabsContent>
          </Tabs>

          <div className="space-y-2 border-t border-border pt-3">
            <div className="flex items-center gap-2">
              <input
                id="recurring"
                type="checkbox"
                checked={recurring}
                onChange={(e) => setRecurring(e.target.checked)}
                className="size-4 rounded border-input"
              />
              <Label htmlFor="recurring">Recurring alert</Label>
            </div>

            {recurring && (
              <div className="space-y-1">
                <Label htmlFor="cooldown">Cooldown (minutes)</Label>
                <Input
                  id="cooldown"
                  type="number"
                  min="1"
                  max="1440"
                  value={cooldownMinutes}
                  onChange={(e) => setCooldownMinutes(e.target.value)}
                />
              </div>
            )}

            <div className="space-y-1">
              <Label htmlFor="alert-message">Note (optional)</Label>
              <Input
                id="alert-message"
                placeholder="Optional note"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createAlert.isPending}>
              {createAlert.isPending ? 'Creating...' : 'Create Alert'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
