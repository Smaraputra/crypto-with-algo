'use client';

import React, { useId, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useCreateAlert } from '@/hooks/useAlerts';
import { useBinanceTicker } from '@/hooks/useBinanceStream';
import { usePortfolio, usePortfolios } from '@/hooks/usePortfolio';
import { useTickers } from '@/hooks/usePrices';
import { useSymbols } from '@/hooks/useSymbols';
import { cn } from '@/lib/utils';
import { formatCurrency } from './AlertList';
import type { AlertType, CreateAlertInput } from '@/types/alert';

export interface AlertSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSymbol?: string;
}

export const ALERT_TYPE_OPTIONS: { value: AlertType; label: string }[] = [
  { value: 'price_above', label: 'Price at or above' },
  { value: 'price_below', label: 'Price at or below' },
  { value: 'price_change_pct', label: 'Price moves by a percent' },
  { value: 'holding_change_pct', label: 'Holding moves by a percent' },
  { value: 'portfolio_value_above', label: 'Portfolio value at or above' },
  { value: 'portfolio_value_below', label: 'Portfolio value at or below' },
];

export const AlertSheet: React.FC<AlertSheetProps> = ({
  open,
  onOpenChange,
  initialSymbol = '',
}) => {
  const formId = useId();
  const createMutation = useCreateAlert();

  const { data: symbolsData } = useSymbols();
  const { data: portfoliosData } = usePortfolios();

  const [symbol, setSymbol] = useState(initialSymbol);
  const [portfolioId, setPortfolioId] = useState('');
  const [type, setType] = useState<AlertType>('price_above');
  const [value, setValue] = useState('');
  const [recurring, setRecurring] = useState(false);
  const [cooldownMinutes, setCooldownMinutes] = useState('60');
  const [message, setMessage] = useState('');

  const [openCoinPopover, setOpenCoinPopover] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const isPercentType =
    type === 'price_change_pct' || type === 'holding_change_pct';
  const isPortfolioValueType =
    type === 'portfolio_value_above' || type === 'portfolio_value_below';
  const requiresPortfolio =
    isPortfolioValueType || type === 'holding_change_pct';
  const requiresSymbol = !isPortfolioValueType;

  const { tickers: binanceTickers } = useBinanceTicker(symbol ? [symbol] : []);
  const { data: restTickers } = useTickers();

  const currentPrice = React.useMemo(() => {
    if (!symbol) return null;
    const binance = binanceTickers[symbol];
    if (binance?.lastPrice) {
      const p = parseFloat(binance.lastPrice);
      if (!isNaN(p)) return p;
    }
    const rest = restTickers?.find((t) => t.symbol === symbol);
    if (rest?.lastPrice) {
      const p = parseFloat(rest.lastPrice);
      if (!isNaN(p)) return p;
    }
    return null;
  }, [symbol, binanceTickers, restTickers]);

  const selectedBaseAsset = React.useMemo(() => {
    if (!symbol) return '';
    const match = symbolsData?.find((s) => s.symbol === symbol);
    return match?.baseAsset || symbol.replace(/(USDT|USDC|BUSD)$/, '') || symbol;
  }, [symbol, symbolsData]);

  const { data: portfolioDetail } = usePortfolio(portfolioId || null);

  const selectedHolding = React.useMemo(() => {
    if (!portfolioDetail?.portfolio?.holdings || !symbol) return null;
    return (
      portfolioDetail.portfolio.holdings.find((h) => h.symbol === symbol) ||
      null
    );
  }, [portfolioDetail, symbol]);

  const isWaitingForPrice =
    type === 'price_change_pct' && (currentPrice === null || currentPrice <= 0);

  const handleSelectPortfolio = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    setPortfolioId(val);
    if (errors.portfolioId) setErrors((prev) => ({ ...prev, portfolioId: '' }));
  };

  const handleSelectHolding = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const sym = e.target.value;
    if (sym) {
      setSymbol(sym);
      if (errors.symbol) setErrors((prev) => ({ ...prev, symbol: '' }));
    }
  };

  const resetForm = () => {
    setSymbol(initialSymbol);
    setPortfolioId('');
    setType('price_above');
    setValue('');
    setRecurring(false);
    setCooldownMinutes('60');
    setMessage('');
    setErrors({});
  };

  const handleClose = () => {
    onOpenChange(false);
    resetForm();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: Record<string, string> = {};

    if (requiresSymbol && !symbol) {
      newErrors.symbol = 'Please select a coin.';
    } else if (
      type === 'holding_change_pct' &&
      portfolioDetail?.portfolio?.holdings &&
      !portfolioDetail.portfolio.holdings.some((h) => h.symbol === symbol)
    ) {
      newErrors.symbol = 'Selected coin is not held in this portfolio.';
    }

    if (requiresPortfolio && !portfolioId) {
      newErrors.portfolioId = 'Please select a portfolio.';
    }

    if (isWaitingForPrice) {
      newErrors.value =
        'Waiting for the current price, which this alert measures from.';
    }

    if (!value || value.trim() === '') {
      newErrors.value = isPercentType
        ? 'Percent change is required.'
        : 'Target price is required.';
    } else {
      const num = parseFloat(value);
      if (isNaN(num)) {
        newErrors.value = 'Please enter a valid number.';
      } else if (isPercentType) {
        if (num === 0) {
          newErrors.value = 'Percent change cannot be 0.';
        } else if (num < -100 || num > 1000) {
          newErrors.value = 'Percent change must be between -100% and 1000%.';
        }
      } else {
        if (num <= 0) {
          newErrors.value = 'Value must be greater than 0.';
        }
      }
    }

    if (recurring) {
      const cd = parseInt(cooldownMinutes, 10);
      if (isNaN(cd) || cd < 1 || cd > 1440) {
        newErrors.cooldownMinutes =
          'Cooldown must be between 1 and 1440 minutes.';
      }
    }

    if (message.length > 500) {
      newErrors.message = 'Note must be at most 500 characters.';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    const payload: CreateAlertInput = {
      type,
    };

    if (symbol) {
      payload.symbol = symbol;
    }

    if (portfolioId) {
      payload.portfolioId = portfolioId;
    }

    if (isPercentType) {
      payload.percentChange = parseFloat(value);
      if (type === 'price_change_pct' && currentPrice !== null) {
        payload.referencePrice = currentPrice;
      }
    } else {
      payload.targetPrice = parseFloat(value);
    }

    if (recurring) {
      payload.recurring = true;
      payload.cooldownMinutes = parseInt(cooldownMinutes, 10) || 60;
    }

    if (message.trim()) {
      payload.message = message.trim();
    }

    try {
      await createMutation.mutateAsync(payload);
      handleClose();
    } catch {
      // Error is handled by useCreateAlert's onError toast
    }
  };

  const valueLabel = isPercentType
    ? 'Percent change'
    : isPortfolioValueType
      ? 'Target portfolio value'
      : 'Target price';

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md p-6 overflow-y-auto flex flex-col justify-between"
      >
        <div className="space-y-6">
          <SheetHeader className="text-left space-y-1">
            <SheetTitle className="text-[20px] font-semibold text-foreground">
              New alert
            </SheetTitle>
            <SheetDescription className="text-[14px] text-muted-foreground">
              Set a price or portfolio condition to be notified.
            </SheetDescription>
          </SheetHeader>

          <form id={formId} onSubmit={handleSubmit} className="space-y-4">


            {/* Coin selector */}
            {requiresSymbol && (
              <div className="flex flex-col gap-1.5">
                <label
                  id="alert-symbol-label"
                  htmlFor="alert-symbol-trigger"
                  className="text-[14px] font-medium text-foreground"
                >
                  Coin
                </label>
                <Popover
                  open={openCoinPopover}
                  onOpenChange={setOpenCoinPopover}
                >
                  <PopoverTrigger asChild>
                    <Button
                      id="alert-symbol-trigger"
                      type="button"
                      variant="outline"
                      role="combobox"
                      aria-expanded={openCoinPopover}
                      aria-labelledby="alert-symbol-label"
                      className="flex min-h-[44px] w-full items-center justify-between px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-semibold text-[14px] focus-visible:outline-3 focus-visible:outline-ring cursor-pointer hover:bg-card"
                    >
                      <span
                        className={cn(
                          !selectedBaseAsset &&
                            'text-muted-foreground font-normal'
                        )}
                      >
                        {selectedBaseAsset || 'Select coin'}
                      </span>
                      <ChevronsUpDown
                        className="size-4 shrink-0 opacity-50"
                        aria-hidden="true"
                      />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-[--radix-popover-trigger-width] min-w-56 p-0"
                    align="start"
                  >
                    <Command>
                      <CommandInput placeholder="Search coin..." />
                      <CommandList>
                        <CommandEmpty>No coin found.</CommandEmpty>
                        <CommandGroup>
                          {symbolsData?.map((s) => (
                            <CommandItem
                              key={s.symbol}
                              value={s.baseAsset}
                              onSelect={() => {
                                setSymbol(s.symbol);
                                setOpenCoinPopover(false);
                                if (errors.symbol) {
                                  setErrors((prev) => ({ ...prev, symbol: '' }));
                                }
                              }}
                            >
                              {s.baseAsset}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
                {errors.symbol && (
                  <p role="alert" className="text-[13px] text-down">
                    {errors.symbol}
                  </p>
                )}
              </div>
            )}

            {/* Alert type selector */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="alert-type"
                className="text-[14px] font-medium text-foreground"
              >
                Alert type
              </label>
              <select
                id="alert-type"
                value={type}
                onChange={(e) => {
                  setType(e.target.value as AlertType);
                  setErrors({});
                }}
                className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-medium text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
              >
                {ALERT_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Portfolio picker */}
            {(requiresPortfolio ||
              (portfoliosData?.portfolios && portfoliosData.portfolios.length > 0)) && (
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="alert-portfolio"
                  className="text-[14px] font-medium text-foreground"
                >
                  {requiresPortfolio ? 'Portfolio' : 'Portfolio (optional)'}
                </label>
                <select
                  id="alert-portfolio"
                  value={portfolioId}
                  onChange={handleSelectPortfolio}
                  className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-medium text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
                >
                  <option value="">
                    {requiresPortfolio ? 'Select portfolio' : 'None'}
                  </option>
                  {portfoliosData?.portfolios?.map((p) => (
                    <option key={p._id} value={p._id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {errors.portfolioId && (
                  <p role="alert" className="text-[13px] text-down">
                    {errors.portfolioId}
                  </p>
                )}
              </div>
            )}

            {/* Optional prefill from selected portfolio holdings */}
            {portfolioDetail?.portfolio?.holdings &&
              portfolioDetail.portfolio.holdings.length > 0 &&
              requiresSymbol && (
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="alert-prefill-holding"
                    className="text-[13px] font-medium text-muted-foreground"
                  >
                    Prefill from portfolio holding (optional)
                  </label>
                  <select
                    id="alert-prefill-holding"
                    onChange={handleSelectHolding}
                    value={symbol || ''}
                    className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-medium text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
                  >
                    <option value="">Select a holding...</option>
                    {portfolioDetail.portfolio.holdings.map((h) => (
                      <option key={h.symbol} value={h.symbol}>
                        {h.baseAsset || h.symbol}
                      </option>
                    ))}
                  </select>
                </div>
              )}

            {/* Target Value field with current price context */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="alert-value"
                  className="text-[14px] font-medium text-foreground shrink-0"
                >
                  {valueLabel}
                </label>
                {type === 'price_change_pct' && (
                  <span className="text-[13px] text-muted-foreground font-sans tabular-nums font-normal text-right">
                    {currentPrice !== null
                      ? `Measured from the current price, ${formatCurrency(currentPrice)}.`
                      : 'Waiting for the current price, which this alert measures from.'}
                  </span>
                )}
                {type === 'holding_change_pct' &&
                  selectedHolding &&
                  selectedHolding.avgBuyPrice !== undefined &&
                  selectedHolding.avgBuyPrice !== null && (
                    <span className="text-[13px] text-muted-foreground font-sans tabular-nums font-normal text-right">
                      {`Measured from your average cost, ${formatCurrency(selectedHolding.avgBuyPrice)}`}
                    </span>
                  )}
                {!isPercentType && requiresSymbol && symbol && (
                  <span className="text-[13px] text-muted-foreground font-sans tabular-nums font-normal text-right">
                    Current price:{' '}
                    {currentPrice !== null
                      ? formatCurrency(currentPrice)
                      : 'n/a'}
                  </span>
                )}
              </div>
              <input
                id="alert-value"
                type="number"
                step="any"
                placeholder={
                  isPercentType ? 'e.g. 5 or -5' : 'e.g. 85000'
                }
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  if (errors.value) {
                    setErrors((prev) => ({ ...prev, value: '' }));
                  }
                }}
                className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-sans tabular-nums text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
              />
              {errors.value && (
                <p role="alert" className="text-[13px] text-down">
                  {errors.value}
                </p>
              )}
            </div>

            {/* Recurring toggle */}
            <div className="pt-1">
              <label
                htmlFor="alert-recurring"
                className="flex items-center gap-3 cursor-pointer min-h-[44px]"
              >
                <input
                  id="alert-recurring"
                  type="checkbox"
                  checked={recurring}
                  onChange={(e) => setRecurring(e.target.checked)}
                  className="size-4 rounded-[4px] border-edge text-brand focus:ring-ring"
                />
                <span className="text-[14px] text-foreground select-none font-medium">
                  Recurring alert
                </span>
              </label>
            </div>

            {/* Cooldown minutes if recurring */}
            {recurring && (
              <div className="flex flex-col gap-1.5 pl-7">
                <label
                  htmlFor="alert-cooldown"
                  className="text-[13px] font-medium text-muted-foreground"
                >
                  Cooldown (minutes)
                </label>
                <input
                  id="alert-cooldown"
                  type="number"
                  min="1"
                  max="1440"
                  value={cooldownMinutes}
                  onChange={(e) => {
                    setCooldownMinutes(e.target.value);
                    if (errors.cooldownMinutes) {
                      setErrors((prev) => ({ ...prev, cooldownMinutes: '' }));
                    }
                  }}
                  className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-sans tabular-nums text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
                />
                {errors.cooldownMinutes && (
                  <p role="alert" className="text-[13px] text-down">
                    {errors.cooldownMinutes}
                  </p>
                )}
              </div>
            )}

            {/* Note / Message */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="alert-message"
                className="text-[14px] font-medium text-foreground"
              >
                Note (optional)
              </label>
              <input
                id="alert-message"
                type="text"
                maxLength={500}
                placeholder="Optional reminder or trigger reason"
                value={message}
                onChange={(e) => {
                  setMessage(e.target.value);
                  if (errors.message) {
                    setErrors((prev) => ({ ...prev, message: '' }));
                  }
                }}
                className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
              />
              {errors.message && (
                <p role="alert" className="text-[13px] text-down">
                  {errors.message}
                </p>
              )}
            </div>
          </form>
        </div>

        <SheetFooter className="flex flex-row justify-end gap-3 pt-6 border-t border-line mt-6">
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            className="min-h-[44px] rounded-[12px] px-4 font-medium"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={createMutation.isPending || isWaitingForPrice}
            className="rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold min-h-[44px] px-6"
          >
            {createMutation.isPending ? 'Creating...' : 'Create alert'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};
