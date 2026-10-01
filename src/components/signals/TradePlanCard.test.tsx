import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { CONTROL_EVIDENCE } from '@/lib/trade-plan/evidence';
import { makeDeskPosition, makeTicket, makeTradePlan, makeTradePlanResponse } from '@/__fixtures__/trade-plan';
import { TradePlanCard } from './TradePlanCard';

describe('TradePlanCard', () => {
  it('shows a loading state', () => {
    render(<TradePlanCard data={undefined} isLoading isError={false} />);
    expect(screen.getByTestId('trade-plan-loading')).toBeInTheDocument();
  });

  it('shows an error state', () => {
    render(<TradePlanCard data={undefined} isLoading={false} isError />);
    expect(screen.getByText(/Trade plan unavailable/)).toBeInTheDocument();
  });

  it('shows the reason when no plan could be built', () => {
    render(
      <TradePlanCard
        data={{
          plan: null,
          unavailableReason: 'No 1h signal has been computed for SOLUSDT yet.',
          liveRecord: null,
          deskPosition: null,
        }}
        isLoading={false}
        isError={false}
      />
    );
    expect(screen.getByTestId('trade-plan-unavailable')).toHaveTextContent('No 1h signal has been computed');
  });

  it('renders a long ticket with levels, size and costs', () => {
    render(<TradePlanCard data={makeTradePlanResponse()} isLoading={false} isError={false} />);
    const ticket = screen.getByTestId('trade-plan-ticket');

    expect(within(ticket).getByText('long')).toHaveClass('text-bullish');
    expect(ticket).toHaveTextContent('SOL at the next 1h open');
    expect(ticket).toHaveTextContent('Score +35.2 is at or above +29');
    expect(ticket).toHaveTextContent('closed 2026-10-01 14:00 UTC');
    expect(ticket).toHaveTextContent('100.00');
    expect(ticket).toHaveTextContent('96.00');
    expect(ticket).toHaveTextContent('-4.00%');
    expect(ticket).toHaveTextContent('108.00');
    expect(ticket).toHaveTextContent('+8.00%');
    expect(ticket).toHaveTextContent('2.48 SOL');
    expect(ticket).toHaveTextContent('248.00 USDT');
    expect(ticket).toHaveTextContent('0.25x');
    expect(ticket).toHaveTextContent('at or below +7.25. No time stop.');

    const costs = screen.getByTestId('trade-plan-costs');
    expect(costs).toHaveTextContent('0.160% if stopped');
    expect(costs).toHaveTextContent('0.100% at the target');
    expect(costs).toHaveTextContent('Costs are 4.0% of the risk');
    expect(costs).toHaveTextContent('+0.0088% paid over the recorded 7-bar hold');
    expect(screen.queryByTestId('trade-plan-not-placeable')).not.toBeInTheDocument();
  });

  it('renders a short ticket with the stop above and the target below', () => {
    const plan = makeTradePlan({
      entry: makeTicket({
        side: 'short',
        stopPrice: 104,
        targetPrice: 92,
        costs: { ...makeTicket().costs, fundingPercent: -0.00875 },
      }),
      signal: { ...makeTradePlan().signal, score: -33, tier: 'sell' },
    });
    render(<TradePlanCard data={makeTradePlanResponse({ plan })} isLoading={false} isError={false} />);
    const ticket = screen.getByTestId('trade-plan-ticket');
    expect(within(ticket).getByText('short')).toHaveClass('text-bearish');
    expect(ticket).toHaveTextContent('at or below -29');
    expect(ticket).toHaveTextContent('+4.00%');
    expect(ticket).toHaveTextContent('-8.00%');
    expect(ticket).toHaveTextContent('at or above -7.25');
    expect(screen.getByTestId('trade-plan-costs')).toHaveTextContent('-0.0088% received');
  });

  it('flags a ticket the venue would reject', () => {
    const plan = makeTradePlan({
      entry: makeTicket({ placeable: false, notPlaceableReason: 'Notional 2.40 USDT is below the BTCUSDT minimum of 50 USDT' }),
    });
    render(<TradePlanCard data={makeTradePlanResponse({ plan })} isLoading={false} isError={false} />);
    expect(screen.getByTestId('trade-plan-not-placeable')).toHaveTextContent(
      'Not placeable: Notional 2.40 USDT is below the BTCUSDT minimum of 50 USDT'
    );
  });

  it('says why funding is not projected when the interval has no recorded hold', () => {
    const plan = makeTradePlan({
      entry: makeTicket({ costs: { ...makeTicket().costs, fundingPercent: null, expectedFundingCrossings: null } }),
    });
    render(<TradePlanCard data={makeTradePlanResponse({ plan })} isLoading={false} isError={false} />);
    expect(screen.getByTestId('trade-plan-costs')).toHaveTextContent('rate +0.0100% per 8h; no recorded hold');
  });

  it('renders the flat state and what to do with an open position', () => {
    const plan = makeTradePlan({
      entry: null,
      signal: { ...makeTradePlan().signal, score: 5.4, tier: 'neutral' },
      holding: { longExits: true, shortExits: true },
    });
    render(<TradePlanCard data={makeTradePlanResponse({ plan })} isLoading={false} isError={false} />);
    expect(screen.getByTestId('trade-plan-flat')).toHaveTextContent('No entry on this 1h bar');
    expect(screen.getByTestId('trade-plan-flat')).toHaveTextContent('Score +5.4 is inside -29 to +29');
    const holding = screen.getByTestId('trade-plan-holding');
    expect(holding).toHaveTextContent('A long: exit at the next open');
    expect(holding).toHaveTextContent('A short: exit at the next open');
  });

  it('shows keep-holding for the side whose exit level has not been reached', () => {
    render(<TradePlanCard data={makeTradePlanResponse()} isLoading={false} isError={false} />);
    const holding = screen.getByTestId('trade-plan-holding');
    expect(holding).toHaveTextContent('A long: keep holding');
    expect(holding).toHaveTextContent('A short: exit at the next open');
  });

  it('shows the recorded evidence with its interval, verdict and provenance', () => {
    render(<TradePlanCard data={makeTradePlanResponse()} isLoading={false} isError={false} />);
    const evidence = screen.getByTestId('trade-plan-evidence');
    expect(evidence).toHaveTextContent('v8 control, 2026-10-02');
    expect(evidence).toHaveTextContent('-0.0551% per trade after costs, 95% CI -0.1527 to +0.0458, 8,467 trades');
    expect(evidence).toHaveTextContent(CONTROL_EVIDENCE['1h'].verdict);
    expect(evidence).toHaveTextContent('dataset e84cd66dbe01');
    expect(screen.getByTestId('trade-plan-evidence-badge')).toHaveTextContent('v8 evidence');
  });

  it('marks stale and missing evidence', () => {
    const { unmount } = render(
      <TradePlanCard
        data={makeTradePlanResponse({ plan: makeTradePlan({ interval: '4h', evidence: CONTROL_EVIDENCE['4h'] }) })}
        isLoading={false}
        isError={false}
      />
    );
    expect(screen.getByTestId('trade-plan-evidence-badge')).toHaveTextContent('Earlier-rule evidence');
    expect(screen.getByTestId('trade-plan-evidence')).toHaveTextContent('95% CI low -0.424');
    unmount();

    render(
      <TradePlanCard
        data={makeTradePlanResponse({ plan: makeTradePlan({ interval: '1m', evidence: CONTROL_EVIDENCE['1m'] }) })}
        isLoading={false}
        isError={false}
      />
    );
    expect(screen.getByTestId('trade-plan-evidence-badge')).toHaveTextContent('No evidence');
    expect(screen.getByTestId('trade-plan-evidence')).toHaveTextContent('Unmeasured');
  });

  it('leads with the research verdict, before what the rule would do', () => {
    render(<TradePlanCard data={makeTradePlanResponse()} isLoading={false} isError={false} />);
    const verdict = screen.getByTestId('trade-plan-verdict');
    const ticket = screen.getByTestId('trade-plan-ticket');
    expect(verdict.compareDocumentPosition(ticket) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('trade-plan-rule-heading')).toHaveTextContent('What the rule would do on this bar');
    expect(ticket).toHaveTextContent('The rule would go long SOL at the next 1h open');
  });

  it('styles a proven loss as bearish: the whole interval is below zero', () => {
    render(
      <TradePlanCard
        data={makeTradePlanResponse({ plan: makeTradePlan({ interval: '15m', evidence: CONTROL_EVIDENCE['15m'] }) })}
        isLoading={false}
        isError={false}
      />
    );
    expect(screen.getByTestId('trade-plan-evidence-badge')).toHaveClass('text-bearish');
    expect(screen.getByTestId('trade-plan-evidence-badge')).toHaveTextContent('v8 evidence');
    expect(screen.getByTestId('trade-plan-verdict')).toHaveClass('text-bearish');
  });

  it('styles a negative estimate whose interval spans zero as a warning', () => {
    render(<TradePlanCard data={makeTradePlanResponse()} isLoading={false} isError={false} />);
    expect(screen.getByTestId('trade-plan-evidence-badge')).toHaveClass('text-accent');
    expect(screen.getByTestId('trade-plan-verdict')).toHaveClass('text-accent');
  });

  it('keeps stale and missing evidence muted, since it carries no current verdict', () => {
    const { unmount } = render(
      <TradePlanCard
        data={makeTradePlanResponse({ plan: makeTradePlan({ interval: '5m', evidence: CONTROL_EVIDENCE['5m'] }) })}
        isLoading={false}
        isError={false}
      />
    );
    expect(screen.getByTestId('trade-plan-evidence-badge')).toHaveClass('text-muted-foreground');
    unmount();
    render(
      <TradePlanCard
        data={makeTradePlanResponse({ plan: makeTradePlan({ interval: '1m', evidence: CONTROL_EVIDENCE['1m'] }) })}
        isLoading={false}
        isError={false}
      />
    );
    expect(screen.getByTestId('trade-plan-evidence-badge')).toHaveClass('text-muted-foreground');
  });

  it('shows the live record per tier and labels it as a different measurement', () => {
    render(<TradePlanCard data={makeTradePlanResponse()} isLoading={false} isError={false} />);
    const live = screen.getByTestId('trade-plan-live-record');
    expect(live).toHaveTextContent('close-to-close over 24 bars, net of 0.16%');
    expect(live).toHaveTextContent('A different measurement from this rule');
    const rows = within(live).getAllByRole('row');
    // Header plus two tiers; the current tier (buy) is emphasised.
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('Long score412-0.051%48.2%');
    expect(rows[1]).toHaveClass('font-medium');
    expect(rows[2]).not.toHaveClass('font-medium');
  });

  it('says so when the live record has no resolved outcomes', () => {
    render(
      <TradePlanCard
        data={makeTradePlanResponse({
          liveRecord: { configVersion: 7, horizonBars: 24, costPercentRoundTrip: 0.16, tiers: [] },
        })}
        isLoading={false}
        isError={false}
      />
    );
    expect(screen.getByTestId('trade-plan-live-record')).toHaveTextContent('No resolved live outcomes yet');
  });

  it('shows the desk\'s real position instead of the hypothetical panel', () => {
    render(
      <TradePlanCard
        data={makeTradePlanResponse({ deskPosition: makeDeskPosition() })}
        isLoading={false}
        isError={false}
      />
    );
    const held = screen.getByTestId('trade-plan-desk-position');
    expect(held).toHaveTextContent('The paper desk holds');
    expect(held).toHaveTextContent('2.48 SOL');
    expect(held).toHaveTextContent('from 100.03');
    expect(held).toHaveTextContent('opened 2026-10-01 10:00 UTC');
    expect(held).toHaveTextContent('-0.03%');
    expect(held).toHaveTextContent('Still held: the score has not reached +7.25');
    // The hypothetical panel is replaced, not shown alongside.
    expect(screen.queryByTestId('trade-plan-holding')).not.toBeInTheDocument();
  });

  it('says when this bar\'s score closes the held position', () => {
    render(
      <TradePlanCard
        data={makeTradePlanResponse({ deskPosition: makeDeskPosition({ exitsNow: true }) })}
        isLoading={false}
        isError={false}
      />
    );
    expect(screen.getByTestId('trade-plan-desk-position')).toHaveTextContent(
      "This bar's score closes it: exit at the next open"
    );
  });

  it('shows the hypothetical panel while the desk is flat', () => {
    render(<TradePlanCard data={makeTradePlanResponse()} isLoading={false} isError={false} />);
    expect(screen.getByTestId('trade-plan-holding')).toBeInTheDocument();
    expect(screen.queryByTestId('trade-plan-desk-position')).not.toBeInTheDocument();
  });

  it('lists the builder notes', () => {
    const plan = makeTradePlan({ notes: ['The stop is measured over 199 true ranges, fewer than the 1000 the rule asks for.'] });
    render(<TradePlanCard data={makeTradePlanResponse({ plan })} isLoading={false} isError={false} />);
    expect(screen.getByTestId('trade-plan-notes')).toHaveTextContent('199 true ranges');
  });
});
