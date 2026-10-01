'use client';

import type { ReactNode } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type {
  ControlEvidence,
  DeskPositionView,
  LiveRecord,
  TradePlan,
  TradePlanResponse,
  TradeTicket,
} from '@/lib/trade-plan/types';
import { evidenceVerdictKind, type EvidenceVerdictKind } from '@/lib/trade-plan/evidence';
import { tierDisplayLabel } from '@/lib/signals/tier-labels';

interface TradePlanCardProps {
  data: TradePlanResponse | undefined;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Tone follows what the record SAYS, not how old it is (review P1). A rule
 * whose whole interval is below zero reads bearish; a negative estimate whose
 * interval still spans zero reads as a warning; stale or missing evidence
 * carries no verdict of its own and stays muted. Until 2026-10-01 this was
 * inverted: the proven-losing 15m row got the calmest style.
 */
const VERDICT_TONE: Record<EvidenceVerdictKind, { text: string; badge: string }> = {
  loses: { text: 'text-bearish', badge: 'border-bearish/40 text-bearish' },
  negative: { text: 'text-accent', badge: 'border-accent/40 text-accent' },
  other: { text: 'text-foreground', badge: 'border-border text-muted-foreground' },
  unmeasured: { text: 'text-muted-foreground', badge: 'border-border text-muted-foreground' },
};

const MUTED_TONE = { text: 'text-muted-foreground', badge: 'border-border text-muted-foreground' };

/** Current evidence is styled by its verdict; stale or missing evidence is muted. */
function evidenceTone(evidence: ControlEvidence) {
  return evidence.status === 'current' ? VERDICT_TONE[evidenceVerdictKind(evidence)] : MUTED_TONE;
}

/** The badge text, derived from the run's own scorer version. */
function evidenceBadgeLabel(evidence: ControlEvidence): string {
  if (evidence.status === 'none') return 'No evidence';
  if (evidence.status === 'stale' || evidence.configVersion === null) return 'Earlier-rule evidence';
  return `v${evidence.configVersion} evidence`;
}

function signed(value: number, digits = 2): string {
  const fixed = value.toFixed(digits);
  return value > 0 ? `+${fixed}` : fixed;
}

/** A recorded figure as it was recorded: up to four decimals, trailing zeros dropped.
 * toFixed(3) would show the recorded +0.0385 as +0.038 (binary rounding). */
function recorded(value: number): string {
  const text = parseFloat(value.toFixed(4)).toString();
  return value > 0 ? `+${text}` : text;
}

function price(value: number, decimals: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function usdt(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function utcTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function baseAsset(symbol: string): string {
  return symbol.replace(/USDT$/, '');
}

/** A label and a value, laid out as one cell of a definition grid. */
function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono tabular-nums text-sm">{children}</dd>
    </div>
  );
}

function Ticket({ plan, ticket }: { plan: TradePlan; ticket: TradeTicket }) {
  const isLong = ticket.side === 'long';
  const { costs } = ticket;
  const exitLevel = isLong ? plan.rule.exitThreshold : plan.rule.shortExitThreshold;

  return (
    <div className="space-y-4" data-testid="trade-plan-ticket">
      <div>
        <p className="text-sm">
          The rule would go{' '}
          <span className={cn('font-semibold', isLong ? 'text-bullish' : 'text-bearish')}>
            {isLong ? 'long' : 'short'}
          </span>{' '}
          {baseAsset(plan.symbol)} at the next {plan.interval} open
        </p>
        <p className="text-xs text-muted-foreground">
          Score <span className="font-mono tabular-nums">{signed(plan.signal.score, 1)}</span> is{' '}
          {isLong ? 'at or above' : 'at or below'}{' '}
          <span className="font-mono tabular-nums">
            {signed(isLong ? plan.rule.entryThreshold : plan.rule.shortEntryThreshold, 0)}
          </span>{' '}
          on the bar that closed {utcTime(plan.signal.closeTime)}
        </p>
      </div>

      <dl className="grid grid-cols-3 gap-3">
        <Field label="Reference (signal close)">{price(ticket.referencePrice, ticket.priceDecimals)}</Field>
        <Field label="Stop">
          <span className="text-bearish">{price(ticket.stopPrice, ticket.priceDecimals)}</span>
          <span className="block text-xs text-muted-foreground">
            {signed(isLong ? -ticket.stopPercent : ticket.stopPercent)}%
          </span>
        </Field>
        <Field label="Target">
          <span className="text-bullish">{price(ticket.targetPrice, ticket.priceDecimals)}</span>
          <span className="block text-xs text-muted-foreground">
            {signed(isLong ? ticket.targetPercent : -ticket.targetPercent)}%
          </span>
        </Field>
      </dl>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Size">
          {ticket.quantity.toFixed(ticket.quantityDecimals)} {baseAsset(plan.symbol)}
        </Field>
        <Field label="Notional">{usdt(ticket.notional)} USDT</Field>
        <Field label="Leverage">{ticket.leverage.toFixed(2)}x</Field>
        <Field label="Risk at stop">{usdt(ticket.riskAmount)} USDT</Field>
      </dl>
      <p className="text-xs text-muted-foreground">
        Sized to risk {(plan.rule.riskPerTrade * 100).toFixed(0)}% of {usdt(plan.rule.equity)} USDT paper equity.
        The stop is two median true ranges of the last {plan.rule.stopWindowBars} bars (
        <span className="font-mono tabular-nums">{ticket.medianTrueRangePercent.toFixed(3)}%</span> each), the
        target twice the stop.
      </p>

      {!ticket.placeable && (
        <p
          className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-xs"
          role="status"
          data-testid="trade-plan-not-placeable"
        >
          Not placeable: {ticket.notPlaceableReason}
        </p>
      )}

      <p className="text-xs">
        <span className="text-muted-foreground">Exit: </span>
        stop, target, or at a bar close once the score is {isLong ? 'at or below' : 'at or above'}{' '}
        <span className="font-mono tabular-nums">{signed(exitLevel)}</span>. No time stop.
      </p>

      <div className="space-y-1 text-xs" data-testid="trade-plan-costs">
        <p>
          <span className="text-muted-foreground">Round trip: </span>
          <span className="font-mono tabular-nums">{costs.roundTripStopPercent.toFixed(3)}%</span> if stopped,{' '}
          <span className="font-mono tabular-nums">{costs.roundTripTargetPercent.toFixed(3)}%</span> at the target.
          Costs are <span className="font-mono tabular-nums">{(costs.costShareOfRisk * 100).toFixed(1)}%</span> of
          the risk.
        </p>
        <p>
          <span className="text-muted-foreground">Funding: </span>
          {costs.fundingPercent === null ? (
            costs.fundingRate === null ? (
              'no rate stored'
            ) : (
              <>
                rate <span className="font-mono tabular-nums">{signed(costs.fundingRate * 100, 4)}%</span> per 8h; no
                recorded hold to project it over
              </>
            )
          ) : (
            <>
              <span className="font-mono tabular-nums">{signed(costs.fundingPercent, 4)}%</span>{' '}
              {costs.fundingPercent >= 0 ? 'paid' : 'received'} over the recorded{' '}
              {plan.evidence.medianHoldBars}-bar hold
            </>
          )}
        </p>
      </div>
    </div>
  );
}

function Flat({ plan }: { plan: TradePlan }) {
  return (
    <div className="space-y-1" data-testid="trade-plan-flat">
      <p className="text-sm">No entry on this {plan.interval} bar</p>
      <p className="text-xs text-muted-foreground">
        Score <span className="font-mono tabular-nums">{signed(plan.signal.score, 1)}</span> is inside{' '}
        <span className="font-mono tabular-nums">
          {signed(plan.rule.shortEntryThreshold, 0)} to {signed(plan.rule.entryThreshold, 0)}
        </span>{' '}
        on the bar that closed {utcTime(plan.signal.closeTime)}
      </p>
    </div>
  );
}

/** What the paper desk actually holds, when it holds something. */
function DeskPosition({
  plan,
  position,
  ticket,
}: {
  plan: TradePlan;
  position: DeskPositionView;
  ticket: TradeTicket | null;
}) {
  const isLong = position.side === 'long';
  const decimals = ticket?.priceDecimals ?? 2;
  const quantityDecimals = ticket?.quantityDecimals ?? 2;
  const exitLevel = isLong ? plan.rule.exitThreshold : plan.rule.shortExitThreshold;

  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="trade-plan-desk-position">
      <p className="text-xs text-muted-foreground">The paper desk holds</p>
      <p className="text-sm">
        <span className={cn('font-semibold', isLong ? 'text-bullish' : 'text-bearish')}>
          {isLong ? 'Long' : 'Short'}
        </span>{' '}
        <span className="font-mono tabular-nums">
          {position.quantity.toFixed(quantityDecimals)} {baseAsset(plan.symbol)}
        </span>{' '}
        from <span className="font-mono tabular-nums">{price(position.entryPrice, decimals)}</span>, opened{' '}
        {utcTime(position.entryTime)}
      </p>
      <dl className="grid grid-cols-3 gap-3">
        <Field label="Stop">{price(position.stopPrice, decimals)}</Field>
        <Field label="Target">
          {position.targetPrice === null ? 'none' : price(position.targetPrice, decimals)}
        </Field>
        <Field label="Unrealised">
          <span className={position.unrealisedPercent >= 0 ? 'text-bullish' : 'text-bearish'}>
            {signed(position.unrealisedPercent)}%
          </span>
        </Field>
      </dl>
      <p className="text-xs">
        {position.exitsNow ? (
          <span className="text-accent">
            This bar&apos;s score closes it: exit at the next open (level{' '}
            <span className="font-mono tabular-nums">{signed(exitLevel)}</span>).
          </span>
        ) : (
          <>
            Still held: the score has not reached{' '}
            <span className="font-mono tabular-nums">{signed(exitLevel)}</span>.
          </>
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        Unrealised is marked at the signal bar&apos;s close and excludes fees and funding.
      </p>
    </div>
  );
}

function Holding({ plan }: { plan: TradePlan }) {
  const rows = [
    { side: 'long', exits: plan.holding.longExits, level: plan.rule.exitThreshold },
    { side: 'short', exits: plan.holding.shortExits, level: plan.rule.shortExitThreshold },
  ];
  return (
    <div className="space-y-1 text-xs" data-testid="trade-plan-holding">
      <p className="text-muted-foreground">For a position from an earlier signal, the rule would</p>
      {rows.map((row) => (
        <p key={row.side}>
          A {row.side}:{' '}
          <span className={cn('font-medium', row.exits ? 'text-accent' : 'text-foreground')}>
            {row.exits ? 'exit at the next open' : 'keep holding'}
          </span>{' '}
          <span className="text-muted-foreground">
            (exit level <span className="font-mono tabular-nums">{signed(row.level)}</span>)
          </span>
        </p>
      ))}
    </div>
  );
}

/**
 * The research verdict on the rule, shown FIRST (review P1): what the record
 * says about the rule comes before what the rule would do on this bar.
 */
function Evidence({ evidence }: { evidence: ControlEvidence }) {
  const tone = evidenceTone(evidence);
  return (
    <div className="space-y-1 text-xs" data-testid="trade-plan-evidence">
      <p className={cn('text-sm font-medium', tone.text)} data-testid="trade-plan-verdict">
        {evidence.verdict}
      </p>
      {evidence.expectancyPercent !== null && (
        <p className="font-mono tabular-nums">
          {recorded(evidence.expectancyPercent)}% per trade after costs
          {evidence.ciLowPercent !== null &&
            (evidence.ciHighPercent !== null
              ? `, 95% CI ${recorded(evidence.ciLowPercent)} to ${recorded(evidence.ciHighPercent)}`
              : `, 95% CI low ${recorded(evidence.ciLowPercent)}`)}
          {evidence.trades !== null && `, ${evidence.trades.toLocaleString('en-US')} trades`}
        </p>
      )}
      <p>
        <span className="text-muted-foreground">Recorded for this rule: </span>
        {evidence.label}
      </p>
      <p className="text-muted-foreground">{evidence.provenance}</p>
    </div>
  );
}

function LiveRecordTable({ record, currentTier }: { record: LiveRecord; currentTier: string }) {
  if (record.tiers.length === 0) {
    return (
      <p className="border-t border-border pt-3 text-xs text-muted-foreground" data-testid="trade-plan-live-record">
        No resolved live outcomes yet under configVersion {record.configVersion}.
      </p>
    );
  }
  return (
    <div className="border-t border-border pt-3" data-testid="trade-plan-live-record">
      <table className="w-full text-xs">
        <caption className="mb-1 text-left text-muted-foreground">
          Live record, configVersion {record.configVersion}: close-to-close over {record.horizonBars} bars, net of{' '}
          {record.costPercentRoundTrip.toFixed(2)}%. A different measurement from this rule.
        </caption>
        <thead>
          <tr className="text-muted-foreground">
            <th scope="col" className="py-1 text-left font-normal">Tier</th>
            <th scope="col" className="py-1 text-right font-normal">Outcomes</th>
            <th scope="col" className="py-1 text-right font-normal">Net</th>
            <th scope="col" className="py-1 text-right font-normal">Win rate</th>
          </tr>
        </thead>
        <tbody className="font-mono tabular-nums">
          {record.tiers.map((row) => (
            <tr key={row.tier} className={cn(row.tier === currentTier && 'text-foreground font-medium')}>
              <td className="py-0.5 font-sans">{tierDisplayLabel(row.tier)}</td>
              <td className="py-0.5 text-right">{row.count.toLocaleString('en-US')}</td>
              <td className={cn('py-0.5 text-right', row.expectancyPercent >= 0 ? 'text-bullish' : 'text-bearish')}>
                {signed(row.expectancyPercent, 3)}%
              </td>
              <td className="py-0.5 text-right">{(row.winRate * 100).toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TradePlanCard({ data, isLoading, isError }: TradePlanCardProps) {
  const plan = data?.plan ?? null;

  return (
    <Card data-testid="trade-plan-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">Trade Plan</CardTitle>
          {plan && (
            <span
              className={cn('rounded-full border px-2 py-0.5 text-xs', evidenceTone(plan.evidence).badge)}
              data-testid="trade-plan-evidence-badge"
            >
              {evidenceBadgeLabel(plan.evidence)}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="space-y-2" data-testid="trade-plan-loading">
            <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
            <div className="h-12 w-full animate-pulse rounded bg-muted" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          </div>
        ) : isError ? (
          <p className="text-sm text-muted-foreground">Trade plan unavailable. It will retry on the next refresh.</p>
        ) : !plan ? (
          <p className="text-sm text-muted-foreground" data-testid="trade-plan-unavailable">
            {data?.unavailableReason ?? 'No trade plan yet.'}
          </p>
        ) : (
          <>
            <Evidence evidence={plan.evidence} />
            <div className="space-y-4 border-t border-border pt-3">
              <p className="text-xs text-muted-foreground" data-testid="trade-plan-rule-heading">
                What the rule would do on this bar
              </p>
              {plan.entry ? <Ticket plan={plan} ticket={plan.entry} /> : <Flat plan={plan} />}
            </div>
            {data?.deskPosition ? (
              <DeskPosition plan={plan} position={data.deskPosition} ticket={plan.entry} />
            ) : (
              <Holding plan={plan} />
            )}
            {plan.notes.length > 0 && (
              <ul className="space-y-1 text-xs text-accent" data-testid="trade-plan-notes">
                {plan.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}
            {data?.liveRecord && <LiveRecordTable record={data.liveRecord} currentTier={plan.signal.tier} />}
            <p className="text-xs text-muted-foreground">
              Research books the entry at the signal close. A live order fills at the next open, which no research run
              has measured.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
