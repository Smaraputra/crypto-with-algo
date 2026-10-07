'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { HOLD_PRESETS, MAX_HOLD_MINUTES, MAX_LEVERAGE, notionalOf, type CostCheckInputs } from '@/lib/costs/cost-check-model';
import type { CostCheckSymbolsResponse } from '@/types/cost-check';
import { NumberField, Segmented } from './fields';
import { SymbolPicker } from './SymbolPicker';

interface CostCheckFormProps {
  inputs: CostCheckInputs;
  onChange: (patch: Partial<CostCheckInputs>) => void;
  symbols: CostCheckSymbolsResponse['symbols'] | undefined;
  symbolsLoading: boolean;
  symbolsError: boolean;
  /** Slippage measured from the book for this size, shown as the override's placeholder. */
  measuredSlippageBps: number | null;
}

const FEE_TIERS = [
  { value: 'standard', label: 'Standard' },
  { value: 'bnb', label: 'BNB discount' },
  { value: 'custom', label: 'Custom' },
] as const;

const FILLS = [
  { value: 'taker', label: 'Market' },
  { value: 'maker', label: 'Limit' },
] as const;

function usdt(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function CostCheckForm({
  inputs,
  onChange,
  symbols,
  symbolsLoading,
  symbolsError,
  measuredSlippageBps,
}: CostCheckFormProps) {
  const preset = HOLD_PRESETS.find((p) => p.minutes === inputs.holdMinutes);

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-sm">Trade</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-3">
          <SymbolPicker
            value={inputs.symbol}
            onChange={(symbol) => onChange({ symbol })}
            symbols={symbols}
            isLoading={symbolsLoading}
            isError={symbolsError}
          />
          <Segmented
            legend="Side"
            name="side"
            value={inputs.side}
            options={[
              { value: 'long', label: 'Long' },
              { value: 'short', label: 'Short' },
            ]}
            onChange={(side) => onChange({ side })}
          />
        </div>

        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Margin"
              unit="USDT"
              value={inputs.margin}
              min={0.01}
              max={10_000_000}
              onChange={(margin) => margin !== null && onChange({ margin })}
            />
            <NumberField
              label="Leverage"
              unit="x"
              value={inputs.leverage}
              min={1}
              max={MAX_LEVERAGE}
              onChange={(leverage) => leverage !== null && onChange({ leverage })}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Position <span className="font-mono tabular-nums text-foreground">{usdt(notionalOf(inputs))}</span> USDT
          </p>
        </div>

        <div className="space-y-2">
          <Segmented
            legend="Hold for"
            name="hold"
            value={preset ? String(preset.minutes) : null}
            options={HOLD_PRESETS.map((p) => ({ value: String(p.minutes), label: p.label }))}
            onChange={(minutes) => onChange({ holdMinutes: Number(minutes) })}
          />
          <NumberField
            label="Or any hold"
            unit="min"
            integer
            value={inputs.holdMinutes}
            min={1}
            max={MAX_HOLD_MINUTES}
            onChange={(holdMinutes) => holdMinutes !== null && onChange({ holdMinutes })}
          />
        </div>

        <div className="space-y-2">
          <Segmented
            legend="Fee schedule"
            name="fee-tier"
            value={inputs.feeTier}
            options={FEE_TIERS}
            onChange={(feeTier) => onChange({ feeTier })}
          />
          <p className="text-xs text-muted-foreground">
            {inputs.feeTier === 'standard' && 'Binance USDT-M VIP 0: 0.02% maker, 0.05% taker.'}
            {inputs.feeTier === 'bnb' && '10% off for paying fees in BNB: 0.018% maker, 0.045% taker. Needs BNB in the futures wallet.'}
            {inputs.feeTier === 'custom' && 'Your own rates, as the fee page shows them.'}
          </p>
          {inputs.feeTier === 'custom' && (
            <div className="grid grid-cols-2 gap-3">
              <NumberField
                label="Maker fee"
                unit="%"
                value={inputs.customMakerPercent}
                min={0}
                max={1}
                onChange={(v) => v !== null && onChange({ customMakerPercent: v })}
              />
              <NumberField
                label="Taker fee"
                unit="%"
                value={inputs.customTakerPercent}
                min={0}
                max={1}
                onChange={(v) => v !== null && onChange({ customTakerPercent: v })}
              />
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-3">
            <Segmented legend="Entry order" name="entry" value={inputs.entry} options={FILLS} onChange={(entry) => onChange({ entry })} />
            <Segmented legend="Exit order" name="exit" value={inputs.exit} options={FILLS} onChange={(exit) => onChange({ exit })} />
          </div>
          {(inputs.entry === 'maker' || inputs.exit === 'maker') && (
            <p className="text-xs text-muted-foreground">
              A limit order fills only if price comes to it. On an entry that fades a move, the fills you get are the
              trades that went against you first, so the lower fee is not free.
            </p>
          )}
          <NumberField
            label="Slippage per market order"
            unit="bps"
            optional
            value={inputs.slippageOverrideBps}
            min={0}
            max={1000}
            placeholder={measuredSlippageBps !== null ? measuredSlippageBps.toFixed(2) : '5'}
            hint="Leave empty to use the order book's measured figure for this size."
            onChange={(slippageOverrideBps) => onChange({ slippageOverrideBps })}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Trades per day"
            value={inputs.tradesPerDay}
            min={0}
            max={10_000}
            onChange={(tradesPerDay) => tradesPerDay !== null && onChange({ tradesPerDay })}
          />
          <NumberField
            label="Account equity"
            unit="USDT"
            optional
            value={inputs.equity}
            min={0.01}
            max={1_000_000_000}
            onChange={(equity) => onChange({ equity })}
          />
        </div>
      </CardContent>
    </Card>
  );
}
