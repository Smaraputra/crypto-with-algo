import type { MonthMeasures } from '@/lib/signals/track-record/types';
import { cn } from '@/lib/utils';

import { count, formatMonth, monthsBelowZero, share, signed } from './format';

interface MonthBarsProps {
  months: MonthMeasures[];
}

/**
 * Average result per call after costs, one bar per month around a zero line:
 * the year at a glance, so one good month cannot pass for the year. The same
 * figures sit in a table below for keyboard and screen-reader use.
 */
export function MonthBars({ months }: MonthBarsProps) {
  const scale = Math.max(...months.map((m) => Math.abs(m.net ?? 0)), 1e-9);
  const { below, withCalls } = monthsBelowZero(months);

  return (
    <section className="mt-4" aria-labelledby="track-record-months">
      <h3 id="track-record-months" className="text-xs font-medium text-foreground">
        Average result per call after costs, by month
      </h3>
      <p className="mt-0.5">
        {withCalls === 0 ? 'No month had a call.' : `${below} of ${withCalls} months with calls were below zero.`}
      </p>
      <div className="mt-2 flex h-20 items-stretch gap-1" role="img" aria-label={`${below} of ${withCalls} months below zero after costs`}>
        {months.map((m) => {
          const h = m.net === null ? 0 : (Math.abs(m.net) / scale) * 50;
          return (
            <div
              key={m.month}
              className="relative flex-1"
              title={`${formatMonth(m.month, true)}: ${count(m.calls)} calls, ${m.net === null ? 'no call' : `${signed(m.net)} per call`}`}
            >
              <div className="absolute inset-x-0 top-1/2 h-px bg-border-strong" />
              {m.net === null ? (
                <div className="absolute left-1/2 top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground" />
              ) : (
                <div
                  className={cn(
                    'absolute inset-x-[15%] rounded-[1px]',
                    m.net >= 0 ? 'bottom-1/2 bg-bullish' : 'top-1/2 bg-bearish'
                  )}
                  style={{ height: `${Math.max(h, 1)}%` }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex gap-1" aria-hidden="true">
        {months.map((m) => (
          <span key={m.month} className="flex-1 text-center text-[10px] leading-none">
            {formatMonth(m.month)}
          </span>
        ))}
      </div>
      <details className="mt-2">
        <summary className="inline-flex min-h-11 cursor-pointer items-center sm:min-h-8 rounded-sm text-xs text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          Show the months as a table
        </summary>
        <div className="mt-2 max-w-2xl overflow-x-auto">
          <table className="w-full min-w-[20rem] text-left text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">Month</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">Calls</th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">Right</th>
                <th scope="col" className="py-1 text-right font-medium">Average after costs</th>
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums text-foreground">
              {months.map((m) => (
                <tr key={m.month} className="border-b border-border/60 last:border-0">
                  <th scope="row" className="py-1 pr-3 font-sans font-normal text-muted-foreground">
                    {formatMonth(m.month, true)}
                  </th>
                  <td className="py-1 pr-3 text-right">{count(m.calls)}</td>
                  <td className="py-1 pr-3 text-right">{share(m.right)}</td>
                  <td className={cn('py-1 text-right', m.net !== null && (m.net < 0 ? 'text-bearish' : 'text-bullish'))}>
                    {signed(m.net)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
