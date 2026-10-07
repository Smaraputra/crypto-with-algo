'use client';

import type { ReactNode } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatHold, MIN_INDEPENDENT_WINDOWS, type CostCheckInputs, type CostCheckModel } from '@/lib/costs/cost-check-model';
import { COST_TONE_LABEL, type CostTone } from '@/lib/costs/verdict';
import { cn } from '@/lib/utils';
import type { CostCheckMarketResponse } from '@/types/cost-check';

interface CostCheckResultProps {
  inputs: CostCheckInputs;
  model: CostCheckModel;
  market: CostCheckMarketResponse | null;
  /** Why market data is missing, when it is. */
  marketProblem: string | null;
  isFetching: boolean;
  /** The first market response for this symbol and hold has not arrived yet. */
  isLoading?: boolean;
}

/**
 * Tone follows how much of the move costs take. There is deliberately no
 * green: "costs are small" is not "this trade is good", only that fees are not
 * what decides it.
 */
const TONE_TEXT: Record<CostTone, string> = {
  small: 'text-foreground',
  material: 'text-accent',
  dominate: 'text-bearish',
  exceed: 'text-bearish',
};

function pct(value: number, digits = 3): string {
  return `${value.toFixed(digits)}%`;
}

function usdt(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function signedUsdt(value: number): string {
  const text = usdt(Math.abs(value));
  return value < 0 ? `-${text}` : text;
}

function Num({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono tabular-nums', className)}>{children}</span>;
}

function utcTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function Verdict({
  inputs,
  model,
  marketProblem,
  isLoading,
}: Pick<CostCheckResultProps, 'inputs' | 'model' | 'marketProblem' | 'isLoading'>) {
  const hold = formatHold(inputs.holdMinutes);
  const { verdict, move } = model;

  if (verdict.kind === 'no-market' && isLoading) {
    return (
      <div className="space-y-1">
        <p className="text-sm font-semibold text-muted-foreground">Measuring the move</p>
        <p className="max-w-prose text-sm text-muted-foreground">
          Reading recent {inputs.symbol} bars, funding and the order book for a {hold} hold.
        </p>
      </div>
    );
  }

  if (verdict.kind === 'no-market') {
    return (
      <div className="space-y-1">
        <p className="text-sm font-semibold text-muted-foreground">No verdict</p>
        <p className="max-w-prose text-sm">
          Market data is unavailable{marketProblem ? `: ${marketProblem}` : ''}. The costs below use a flat{' '}
          <Num>{model.slippageBps}</Num> bps slippage and no funding; without the measured move there is nothing to
          weigh them against.
        </p>
      </div>
    );
  }

  if (verdict.kind === 'thin') {
    return (
      <div className="space-y-1">
        <p className="text-sm font-semibold text-muted-foreground">Too little history for a verdict</p>
        <p className="max-w-prose text-sm">
          The move of a {hold} hold rests on <Num>{verdict.independentWindows}</Num> independent windows; a verdict needs{' '}
          <Num>{MIN_INDEPENDENT_WINDOWS}</Num>. Recently listed perpetuals and long holds run into this.
        </p>
      </div>
    );
  }

  const { tone, breakeven } = verdict;
  return (
    <div className="space-y-2">
      <p className={cn('text-base font-semibold', TONE_TEXT[tone])} data-testid="cost-check-tone">
        {COST_TONE_LABEL[tone]}
      </p>
      {breakeven.kind === 'impossible' ? (
        <p className="max-w-prose text-sm">
          The round trip, <Num>{pct(model.verdictCostPercent)}</Num>, is larger than the typical{' '}
          <Num>{pct(move!.meanPercent, 2)}</Num> move of a {hold} hold. When wins and losses are about that size, no win
          rate breaks even.
        </p>
      ) : (
        <p className="max-w-prose text-sm">
          If wins and losses are each about the typical <Num>{pct(move!.meanPercent, 2)}</Num> move of a {hold} hold, you
          must call direction right more than <Num className="font-semibold">{(breakeven.winRate * 100).toFixed(1)}%</Num>{' '}
          of the time just to cover <Num>{pct(model.verdictCostPercent)}</Num> of costs.
        </p>
      )}
      <p className="max-w-prose text-xs text-muted-foreground">
        Leverage does not change this percentage; it multiplies the USDT at stake. A coin flip is 50%; the best signals the
        research behind this app measured called direction right about 51 to 54% of the time.
      </p>
    </div>
  );
}

function Row({ label, percent, amount, note }: { label: string; percent: number; amount: number; note?: ReactNode }) {
  return (
    <tr className="border-b border-border last:border-0">
      <th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">
        {label}
        {note && <span className="block text-xs">{note}</span>}
      </th>
      <td className="py-1.5 pl-3 text-right align-top">
        <Num>{pct(percent, 4)}</Num>
      </td>
      <td className="py-1.5 pl-3 text-right align-top">
        <Num>{signedUsdt(amount)}</Num>
      </td>
    </tr>
  );
}

export function CostCheckResult({
  inputs,
  model,
  market,
  marketProblem,
  isFetching,
  isLoading = false,
}: CostCheckResultProps) {
  const { roundTrip, move } = model;
  const fundingNote = market
    ? model.settlements === 0
      ? `no settlement in the hold (every ${market.funding.intervalHours}h)`
      : `${model.settlements} settlement${model.settlements === 1 ? '' : 's'} at ${(market.funding.rate * 100).toFixed(4)}% each, every ${market.funding.intervalHours}h`
    : 'unknown without market data';
  const slippageNote =
    model.slippageSource === 'override'
      ? 'your figure'
      : model.slippageSource === 'depth'
        ? market?.slippage.exceedsTopOfBook
          ? 'larger than the visible book: at least this much'
          : 'measured from the order book for this size'
        : 'flat assumption, no order book';

  return (
    <div className="space-y-4" aria-busy={isFetching}>
      <Card className="gap-3">
        <CardHeader>
          <CardTitle className="text-sm">Verdict</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div role="status" aria-live="polite" data-testid="cost-check-verdict">
            <Verdict inputs={inputs} model={model} marketProblem={marketProblem} isLoading={isLoading} />
          </div>
          {market?.stale && (
            <p className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs" role="note">
              The exchange could not be reached. Market data is from {utcTime(market.asOf)}, and slippage falls back to a
              flat figure.
            </p>
          )}
          {model.belowMinNotional && model.effectiveMinNotional !== null && (
            <p className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs" role="note">
              Below the venue minimum: an order on {inputs.symbol} must be at least{' '}
              <Num>{usdt(model.effectiveMinNotional)}</Num> USDT.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="gap-3">
        <CardHeader>
          <CardTitle className="text-sm">Round trip</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm" data-testid="cost-check-breakdown">
            <caption className="sr-only">Round-trip cost of the position, in percent of notional and in USDT</caption>
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th scope="col" className="pb-1 text-left font-normal">
                  Component
                </th>
                <th scope="col" className="pb-1 pl-3 text-right font-normal whitespace-nowrap">
                  Of position
                </th>
                <th scope="col" className="pb-1 pl-3 text-right font-normal">
                  USDT
                </th>
              </tr>
            </thead>
            <tbody>
              <Row label="Fees" percent={roundTrip.feePercent} amount={roundTrip.feeUsdt} />
              <Row
                label="Slippage"
                percent={roundTrip.slippagePercent}
                amount={roundTrip.slippageUsdt}
                note={
                  <>
                    <Num>{model.slippageBps.toFixed(2)}</Num> bps per market order, {slippageNote}
                  </>
                }
              />
              <Row
                label={roundTrip.fundingUsdt < 0 ? 'Funding received' : 'Funding'}
                percent={roundTrip.fundingPercent}
                amount={roundTrip.fundingUsdt}
                note={fundingNote}
              />
              <tr>
                <th scope="row" className="pt-2 text-left font-semibold">
                  Total
                </th>
                <td className="pt-2 pl-3 text-right">
                  <Num className="font-semibold">{pct(roundTrip.totalPercent, 4)}</Num>
                </td>
                <td className="pt-2 pl-3 text-right">
                  <Num className="font-semibold">{signedUsdt(roundTrip.totalUsdt)}</Num>
                </td>
              </tr>
            </tbody>
          </table>
          {roundTrip.fundingUsdt < 0 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Funding received is shown but not credited in the verdict: the rate can turn before the hold ends.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="gap-3">
          <CardHeader>
            <CardTitle className="text-sm">The move</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {move && market ? (
              <>
                <p>
                  A {formatHold(inputs.holdMinutes)} hold typically moves <Num>{pct(move.medianPercent, 2)}</Num> either way
                  (mean <Num>{pct(move.meanPercent, 2)}</Num>); one hold in four moves more than{' '}
                  <Num>{pct(move.p75Percent, 2)}</Num>.
                </p>
                <p className="text-xs text-muted-foreground">
                  Close to close on the last <Num>{market.measurement.barsUsed}</Num> {market.measurement.interval} bars of{' '}
                  {market.symbol}, measured as {market.measurement.holdBars} bars (
                  {formatHold(market.measurement.measuredHoldMs / 60_000)}); <Num>{move.independentWindows}</Num>{' '}
                  independent windows.
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">Not measured.</p>
            )}
          </CardContent>
        </Card>

        <Card className="gap-3">
          <CardHeader>
            <CardTitle className="text-sm">Leverage and turnover</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>
              At <Num>{inputs.leverage}x</Num> a round trip costs <Num>{pct(model.costPercentOfMargin, 2)}</Num> of the margin,
              and liquidation is at most <Num>{pct(model.liquidationDistancePercent, 1)}</Num> away.
            </p>
            <p>
              At <Num>{inputs.tradesPerDay}</Num> trades a day, costs come to about{' '}
              <Num>{usdt(model.burn.perMonthUsdt)}</Num> USDT a month
              {model.burn.percentOfEquity !== null && (
                <>
                  , <Num>{pct(model.burn.percentOfEquity, 1)}</Num> of the account
                </>
              )}
              .
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
