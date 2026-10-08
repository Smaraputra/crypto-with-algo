import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { ProvisionalSignalState } from '@/hooks/useProvisionalSignal';
import { evidenceFor } from '@/lib/trade-plan/evidence';
import { SignalScoreStrip, resolveStyle } from './SignalScoreStrip';

const HOUR = 3_600_000;

function signal(over: Partial<ProvisionalSignalState> = {}): ProvisionalSignalState {
  return {
    status: 'provisional',
    reason: null,
    provisional: { openTime: HOUR, score: 31.25, tier: 'buy', confidence: 72.4, components: [] },
    recorded: new Map(),
    configVersion: 8,
    lastComputeMs: 3,
    ...over,
  };
}

function strip(over: Partial<ProvisionalSignalState> = {}, interval = '1h', style: 'day_trading' | 'swing_trading' | 'position_trading' = 'day_trading', onStyleChange = vi.fn()) {
  return render(
    <SignalScoreStrip symbol="BTCUSDT" interval={interval} style={style} signal={signal(over)} onStyleChange={onStyleChange} />
  );
}

const status = () => screen.getByTestId('signal-score-status');

describe('SignalScoreStrip', () => {
  it('shows the heading and the legend sentence with the config version', () => {
    strip();
    expect(screen.getByRole('heading')).toHaveTextContent('Signal score · Day trading · 1h');
    expect(screen.getByTestId('signal-score-strip')).toHaveTextContent(
      "Filled bars are the scheduler's recorded scores (configVersion 8). The hollow bar is provisional: it repaints until the bar closes and is never recorded."
    );
  });

  it('shows the provisional line with a tier label, never Buy or Sell', () => {
    strip();
    expect(status()).toHaveTextContent('Provisional 31.3 · Long score · 72% data coverage');
    expect(screen.getByTestId('signal-score-strip').textContent).not.toMatch(/\b(buy|sell)\b/i);
  });

  it.each([
    ['awaiting-record', {}, "Bar closed. Waiting for the scheduler's recorded score."],
    ['no-record', {}, 'No recorded score arrived for the last bar.'],
    ['waiting', { reason: 'awaiting-candle-sync' }, 'Waiting for the last closed bar to sync.'],
    ['waiting', { reason: 'insufficient-history' }, 'Not enough history at this interval.'],
    ['loading', {}, 'Loading signal inputs.'],
    ['unavailable', {}, 'No scheduler score for BTCUSDT at 1h.'],
  ] as const)('shows the %s line', (st, extra, text) => {
    strip({ status: st, provisional: null, ...extra });
    expect(status()).toHaveTextContent(text);
  });

  it('shows the newest recorded score when recorded', () => {
    strip({
      status: 'recorded',
      provisional: null,
      recorded: new Map([
        [1, { score: 5, tier: 'neutral', confidence: 50, configVersion: 8 }],
        [2, { score: -33.04, tier: 'sell', confidence: 60, configVersion: 8 }],
      ]),
    });
    expect(status()).toHaveTextContent('Recorded -33.0 · Short score');
    expect(status().textContent).not.toMatch(/\b(buy|sell)\b/i);
  });

  it.each(['5m', '15m', '1h', '4h', '1d'])('keeps the evidence verdict for %s unchanged', (interval) => {
    strip({}, interval);
    expect(screen.getByTestId('signal-score-strip')).toHaveTextContent(
      `Measured record at ${interval}: ${evidenceFor(interval).verdict}`
    );
  });

  it('shows the style toggle only at 1d, with aria-pressed and a change callback', () => {
    const { unmount } = strip({}, '1h');
    expect(screen.queryByRole('button')).toBeNull();
    unmount();

    const onStyleChange = vi.fn();
    strip({}, '1d', 'swing_trading', onStyleChange);
    const swing = screen.getByRole('button', { name: 'Swing' });
    const position = screen.getByRole('button', { name: 'Position' });
    expect(swing).toHaveAttribute('aria-pressed', 'true');
    expect(position).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(position);
    expect(onStyleChange).toHaveBeenCalledWith('position_trading');
  });

  it('announces status changes, not values', () => {
    const { rerender } = strip();
    const live = screen.getByTestId('signal-score-live');
    expect(live).toHaveAttribute('aria-live', 'polite');
    const before = live.textContent;
    rerender(
      <SignalScoreStrip
        symbol="BTCUSDT" interval="1h" style="day_trading" onStyleChange={vi.fn()}
        signal={signal({ provisional: { openTime: HOUR, score: -50, tier: 'sell', confidence: 10, components: [] } })}
      />
    );
    expect(live.textContent).toBe(before);
    expect(live.textContent).not.toMatch(/\d/);
    rerender(
      <SignalScoreStrip
        symbol="BTCUSDT" interval="1h" style="day_trading" onStyleChange={vi.fn()}
        signal={signal({ status: 'awaiting-record' })}
      />
    );
    expect(live.textContent).not.toBe(before);
    expect(status()).not.toHaveAttribute('aria-live');
  });
});

describe('resolveStyle', () => {
  it('uses the first style off 1d and the chosen one at 1d', () => {
    expect(resolveStyle('1h', 'position_trading')).toBe('day_trading');
    expect(resolveStyle('1d', null)).toBe('swing_trading');
    expect(resolveStyle('1d', 'position_trading')).toBe('position_trading');
    expect(resolveStyle('1d', 'scalping')).toBe('swing_trading');
  });
});
