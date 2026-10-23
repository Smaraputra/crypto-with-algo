'use client';

import React, { useState } from 'react';
import { Panel } from '@/components/kit/Panel';
import { SegmentedControl, type SegmentedControlOption } from '@/components/kit/SegmentedControl';
import {
  HOLD_PRESETS,
  MAX_HOLD_MINUTES,
  MAX_LEVERAGE,
  notionalOf,
  type CostCheckInputs,
} from '@/lib/costs/cost-check-model';
import type { CostFeeTier } from '@/lib/costs/round-trip';
import type { FillKind } from '@/lib/backtest/cost-model';
import type { CostCheckSymbolsResponse } from '@/types/cost-check';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CostInputsProps {
  inputs: CostCheckInputs;
  updateInputs: (patch: Partial<CostCheckInputs>) => void;
  symbols: {
    list: CostCheckSymbolsResponse['symbols'] | undefined;
    isLoading: boolean;
    isError: boolean;
  };
  className?: string;
}

const HOLD_OPTIONS: SegmentedControlOption[] = HOLD_PRESETS.map((p) => ({
  label: p.label,
  value: String(p.minutes),
}));

const SIDE_OPTIONS: SegmentedControlOption[] = [
  { label: 'Long', value: 'long' },
  { label: 'Short', value: 'short' },
];

const ORDER_KIND_OPTIONS: SegmentedControlOption[] = [
  { label: 'Taker', value: 'taker' },
  { label: 'Maker', value: 'maker' },
];

const FEE_TIER_OPTIONS: SegmentedControlOption[] = [
  { label: 'Standard', value: 'standard' },
  { label: 'BNB discount', value: 'bnb' },
  { label: 'Custom', value: 'custom' },
];

interface NumberFieldProps {
  id: string;
  label: string;
  sublabel?: React.ReactNode;
  value: number | null;
  onChange: (value: number | null) => void;
  allowNull?: boolean;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  placeholder?: string;
  validate?: (val: number) => string | null;
  labelClassName?: string;
  inputClassName?: string;
  containerClassName?: string;
}

const NumberField: React.FC<NumberFieldProps> = ({
  id,
  label,
  sublabel,
  value,
  onChange,
  allowNull = false,
  min,
  max,
  step = 'any',
  placeholder,
  validate,
  labelClassName = 'text-[14px] font-medium text-foreground',
  inputClassName,
  containerClassName,
}) => {
  const [text, setText] = useState<string>(() =>
    value === null || Number.isNaN(value) ? '' : String(value)
  );
  const lastSentValue = React.useRef<number | null>(value);

  React.useEffect(() => {
    if (value !== lastSentValue.current) {
      setText(value === null || Number.isNaN(value) ? '' : String(value));
      lastSentValue.current = value;
    }
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setText(raw);

    if (raw.trim() === '') {
      if (allowNull) {
        lastSentValue.current = null;
        onChange(null);
      }
      return;
    }

    const parsed = parseFloat(raw);
    if (Number.isFinite(parsed)) {
      lastSentValue.current = parsed;
      onChange(parsed);
    }
  };

  let error: string | null = null;
  if (text.trim() === '') {
    if (!allowNull) {
      error = 'Enter a number.';
    }
  } else {
    const parsed = parseFloat(text);
    if (!Number.isFinite(parsed)) {
      error = 'Enter a number.';
    } else if (validate) {
      error = validate(parsed);
    }
  }

  return (
    <div className={cn('flex flex-col gap-1.5', containerClassName)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className={labelClassName}>
          {label}
        </label>
        {sublabel && (
          <span className="text-[12px] text-muted-foreground font-sans tabular-nums">
            {sublabel}
          </span>
        )}
      </div>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        value={text}
        onChange={handleChange}
        className={cn(
          'min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-sans tabular-nums text-[14px] focus-visible:outline-3 focus-visible:outline-ring',
          inputClassName
        )}
      />
      {error && (
        <p role="alert" className="text-[13px] text-down">
          {error}
        </p>
      )}
    </div>
  );
};

export const CostInputs: React.FC<CostInputsProps> = ({
  inputs,
  updateInputs,
  symbols,
  className,
}) => {
  const [openCoinPopover, setOpenCoinPopover] = useState(false);

  const selectedBaseAsset =
    symbols.list?.find((s) => s.symbol === inputs.symbol)?.baseAsset ||
    inputs.symbol.replace(/USDT$/, '');

  const notional = notionalOf(inputs);
  const formattedNotional = notional.toLocaleString('en-US', {
    minimumFractionDigits: notional % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  });

  return (
    <Panel title="Trade inputs" className={cn('space-y-5', className)}>
      {/* Coin Selector */}
      <div className="flex flex-col gap-1.5">
        <label
          id="cost-coin-label"
          htmlFor="cost-coin-trigger"
          className="text-[14px] font-medium text-foreground"
        >
          Coin
        </label>
        <Popover open={openCoinPopover} onOpenChange={setOpenCoinPopover}>
          <PopoverTrigger asChild>
            <Button
              id="cost-coin-trigger"
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={openCoinPopover}
              aria-labelledby="cost-coin-label"
              disabled={symbols.isLoading}
              className="flex min-h-[44px] w-full items-center justify-between px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-semibold text-[14px] focus-visible:outline-3 focus-visible:outline-ring cursor-pointer hover:bg-card"
            >
              <span>
                {symbols.isLoading
                  ? 'Loading coins...'
                  : symbols.isError
                    ? 'Coins unavailable'
                    : selectedBaseAsset || 'Select coin'}
              </span>
              <ChevronsUpDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[--radix-popover-trigger-width] min-w-56 p-0" align="start">
            <Command>
              <CommandInput placeholder="Search coin..." />
              <CommandList>
                <CommandEmpty>No coin found.</CommandEmpty>
                <CommandGroup>
                  {symbols.list?.map((s) => (
                    <CommandItem
                      key={s.symbol}
                      value={`${s.baseAsset} ${s.symbol}`}
                      onSelect={() => {
                        updateInputs({ symbol: s.symbol });
                        setOpenCoinPopover(false);
                      }}
                    >
                      <div className="flex items-center justify-between w-full">
                        <span className="font-semibold">{s.baseAsset}</span>
                        <span className="text-[12px] text-muted-foreground font-sans tabular-nums">
                          {s.symbol}
                        </span>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>

      {/* Side: Long / Short */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[14px] font-medium text-foreground">Direction</span>
        <SegmentedControl
          legend="Position direction"
          options={SIDE_OPTIONS}
          value={inputs.side}
          onChange={(val) => updateInputs({ side: val as 'long' | 'short' })}
          className="self-start max-w-full"
        />
      </div>

      {/* Margin */}
      <NumberField
        id="cost-margin-input"
        label="Margin (USDT)"
        value={inputs.margin}
        min={1}
        step="any"
        validate={(val) => (val <= 0 ? 'Margin must be greater than 0.' : null)}
        onChange={(val) => {
          if (val !== null) updateInputs({ margin: val });
        }}
      />

      {/* Leverage */}
      <NumberField
        id="cost-leverage-input"
        label="Leverage"
        sublabel={`Between 1x and ${MAX_LEVERAGE}x`}
        value={inputs.leverage}
        min={1}
        max={MAX_LEVERAGE}
        step={1}
        validate={(val) =>
          val > MAX_LEVERAGE
            ? `Leverage cannot exceed ${MAX_LEVERAGE}x.`
            : val < 1
              ? 'Leverage must be at least 1x.'
              : null
        }
        onChange={(val) => {
          if (val !== null) updateInputs({ leverage: val });
        }}
      />

      {/* Read-only notional line */}
      <div
        data-testid="notional-display"
        className="p-3 rounded-[10px] bg-muted/60 border border-line text-[14px] font-semibold text-foreground font-sans tabular-nums"
      >
        Position size: ${formattedNotional}
      </div>

      {/* Hold duration */}
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[14px] font-medium text-foreground">Hold duration</span>
          <span className="text-[12px] text-muted-foreground font-sans tabular-nums">
            Presets or custom
          </span>
        </div>
        <div className="overflow-x-auto max-w-full">
          <SegmentedControl
            legend="Hold duration presets"
            options={HOLD_OPTIONS}
            value={String(inputs.holdMinutes)}
            onChange={(val) => updateInputs({ holdMinutes: Number(val) })}
            className="self-start max-w-full"
          />
        </div>

        <NumberField
          id="cost-hold-custom-input"
          label="Custom hold (minutes)"
          labelClassName="text-[13px] text-muted-foreground font-medium"
          sublabel={`Up to ${MAX_HOLD_MINUTES.toLocaleString()} minutes`}
          value={inputs.holdMinutes}
          min={1}
          max={MAX_HOLD_MINUTES}
          step={1}
          validate={(val) =>
            val > MAX_HOLD_MINUTES
              ? `Hold cannot exceed ${MAX_HOLD_MINUTES.toLocaleString()} minutes (30 days).`
              : val < 1
                ? 'Hold must be at least 1 minute.'
                : null
          }
          onChange={(val) => {
            if (val !== null) updateInputs({ holdMinutes: Math.round(val) });
          }}
          containerClassName="pt-1"
        />
      </div>

      {/* Order execution and fees section */}
      <div className="border-t border-line pt-4 space-y-4">
        <h3 className="text-[14px] font-semibold text-foreground">Execution and fees</h3>

        {/* Entry order */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-muted-foreground">Entry order</span>
          <SegmentedControl
            legend="Entry order fill kind"
            options={ORDER_KIND_OPTIONS}
            value={inputs.entry}
            onChange={(val) => updateInputs({ entry: val as FillKind })}
            className="self-start max-w-full"
          />
        </div>

        {/* Exit order */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-muted-foreground">Exit order</span>
          <SegmentedControl
            legend="Exit order fill kind"
            options={ORDER_KIND_OPTIONS}
            value={inputs.exit}
            onChange={(val) => updateInputs({ exit: val as FillKind })}
            className="self-start max-w-full"
          />
        </div>

        {/* Fee tier */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-muted-foreground">Fee schedule</span>
          <SegmentedControl
            legend="Fee schedule tier"
            options={FEE_TIER_OPTIONS}
            value={inputs.feeTier}
            onChange={(val) => updateInputs({ feeTier: val as CostFeeTier })}
            className="self-start max-w-full"
          />
        </div>

        {/* Custom fee inputs when custom tier */}
        {inputs.feeTier === 'custom' && (
          <div className="grid grid-cols-2 gap-3 p-3 rounded-[10px] bg-muted/40 border border-line">
            <NumberField
              id="cost-custom-maker-input"
              label="Custom maker fee (%)"
              labelClassName="text-[12px] font-medium text-muted-foreground"
              inputClassName="rounded-[10px] text-[13px]"
              value={inputs.customMakerPercent}
              min={0}
              max={1}
              step={0.001}
              validate={(val) =>
                val < 0
                  ? 'Maker fee cannot be negative.'
                  : val > 1
                    ? 'Maker fee cannot exceed 1%.'
                    : null
              }
              onChange={(val) => {
                if (val !== null) updateInputs({ customMakerPercent: val });
              }}
            />
            <NumberField
              id="cost-custom-taker-input"
              label="Custom taker fee (%)"
              labelClassName="text-[12px] font-medium text-muted-foreground"
              inputClassName="rounded-[10px] text-[13px]"
              value={inputs.customTakerPercent}
              min={0}
              max={1}
              step={0.001}
              validate={(val) =>
                val < 0
                  ? 'Taker fee cannot be negative.'
                  : val > 1
                    ? 'Taker fee cannot exceed 1%.'
                    : null
              }
              onChange={(val) => {
                if (val !== null) updateInputs({ customTakerPercent: val });
              }}
            />
          </div>
        )}

        {/* Slippage override */}
        <NumberField
          id="cost-slippage-override-input"
          label="Slippage override (bps)"
          labelClassName="text-[13px] font-medium text-muted-foreground"
          sublabel="Blank uses order book"
          placeholder="Auto (order book)"
          value={inputs.slippageOverrideBps}
          allowNull={true}
          min={0}
          max={1000}
          step={1}
          validate={(val) =>
            val < 0
              ? 'Slippage cannot be negative.'
              : val > 1000
                ? 'Slippage cannot exceed 1000 bps.'
                : null
          }
          onChange={(val) => updateInputs({ slippageOverrideBps: val })}
        />

        {/* Trades per day */}
        <NumberField
          id="cost-trades-per-day-input"
          label="Trades per day"
          labelClassName="text-[13px] font-medium text-muted-foreground"
          sublabel="For monthly cost burn"
          value={inputs.tradesPerDay}
          min={0}
          max={10000}
          step={1}
          validate={(val) =>
            val < 0
              ? 'Trades per day cannot be negative.'
              : val > 10000
                ? 'Trades per day cannot exceed 10,000.'
                : null
          }
          onChange={(val) => {
            if (val !== null) updateInputs({ tradesPerDay: val });
          }}
        />

        {/* Account equity */}
        <NumberField
          id="cost-equity-input"
          label="Account equity (USDT)"
          labelClassName="text-[13px] font-medium text-muted-foreground"
          sublabel="Optional"
          placeholder="Optional"
          value={inputs.equity}
          allowNull={true}
          min={0}
          step="any"
          validate={(val) =>
            val <= 0
              ? 'Equity must be greater than 0.'
              : val > 1_000_000_000
                ? 'Equity cannot exceed 1,000,000,000 USDT.'
                : null
          }
          onChange={(val) => updateInputs({ equity: val })}
        />
      </div>
    </Panel>
  );
};
