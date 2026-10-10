import type { IntervalPair } from '@/lib/signals/track-record/types';

import { share } from './format';

interface HitRateRulerProps {
  right: number;
  interval: IntervalPair | null;
  breakEven: number | null;
}

/**
 * One line, three marks: how often the calls were right (with its 95% range),
 * the coin flip at 50%, and the right-rate needed to break even after costs.
 * The domain hugs the marks, so a few points of difference stay visible.
 */
export function rulerDomain(values: number[]): { min: number; max: number } {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const min = Math.max(0, Math.floor((lo - 0.05) * 10) / 10);
  const max = Math.min(1, Math.ceil((hi + 0.05) * 10) / 10);
  return max > min ? { min, max } : { min: 0, max: 1 };
}

export function HitRateRuler({ right, interval, breakEven }: HitRateRulerProps) {
  const reachable = breakEven !== null && breakEven < 1 ? breakEven : null;
  const values = [0.5, right, ...(interval ? [interval.lo, interval.hi] : []), ...(reachable !== null ? [reachable] : [])];
  const { min, max } = rulerDomain(values);
  const pos = (v: number) => ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * 100;
  // A label shifted left by its own anchor share stays inside the track at any width:
  // left-aligned at the left end, right-aligned at the right end.
  const anchored = (v: number) => ({ left: `${pos(v)}%`, transform: `translateX(-${pos(v)}%)` });

  // The reference labels take a row each, in value order, so they never collide.
  const refs = [
    { key: 'coin', value: 0.5, label: 'Coin flip 50%', text: 'text-muted-foreground', tick: 'bg-muted-foreground' },
    ...(reachable !== null
      ? [{ key: 'even', value: reachable, label: `Break-even ${share(reachable)}`, text: 'text-accent', tick: 'bg-accent' }]
      : []),
  ].sort((a, b) => a.value - b.value);

  const summary = `Right ${share(right)}${interval ? ` (95% range ${share(interval.lo)} to ${share(interval.hi)})` : ''}, coin flip 50%${
    reachable !== null ? `, break-even ${share(reachable)}` : ''
  }.`;

  return (
    <figure className="mt-4" data-testid="hit-rate-ruler">
      <figcaption className="sr-only">{summary}</figcaption>
      <div className="relative h-[4.75rem] px-9" aria-hidden="true">
        <span className="absolute left-0 top-[1.3rem] font-mono text-[11px] tabular-nums text-muted-foreground">
          {Math.round(min * 100)}%
        </span>
        <span className="absolute right-0 top-[1.3rem] font-mono text-[11px] tabular-nums text-muted-foreground">
          {Math.round(max * 100)}%
        </span>
        <div className="relative h-full">
          <span
            className="absolute top-0 whitespace-nowrap font-mono text-xs font-medium tabular-nums text-foreground"
            style={anchored(right)}
          >
            Right {share(right)}
          </span>
          <div className="absolute inset-x-0 top-7 h-px bg-border-strong" />
          {interval && (
            <div
              className="absolute top-[1.375rem] h-3 rounded-sm bg-foreground/15"
              style={{ left: `${pos(interval.lo)}%`, width: `${pos(interval.hi) - pos(interval.lo)}%` }}
            />
          )}
          {refs.map((ref, i) => (
            <div key={ref.key}>
              <div className={`absolute top-5 h-5 w-0.5 -translate-x-1/2 ${ref.tick}`} style={{ left: `${pos(ref.value)}%` }} />
              <span
                className={`absolute whitespace-nowrap font-mono text-xs tabular-nums ${ref.text} ${i === 0 ? 'top-11' : 'top-[3.75rem]'}`}
                style={anchored(ref.value)}
              >
                {ref.label}
              </span>
            </div>
          ))}
          <div
            className="absolute top-[1.4375rem] size-2.5 -translate-x-1/2 rounded-full border border-background bg-foreground"
            style={{ left: `${pos(right)}%` }}
          />
        </div>
      </div>
      {interval && <p className="mt-1 text-[11px]">Shaded: the 95% range for this symbol&apos;s year.</p>}
    </figure>
  );
}
