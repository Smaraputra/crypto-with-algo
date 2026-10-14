import Link from 'next/link';

import { V8_STATUS } from '@/lib/signals/v8-status';

/**
 * The standing label for v8 output. A plain bordered note in the surface
 * language of the cards around it: the label is the one emphasised phrase,
 * the studies sit behind a native disclosure so they cost no space by default.
 */
export function V8StatusBanner() {
  return (
    <section
      aria-label="v8 measurement status"
      data-testid="v8-status-banner"
      className="rounded-md border border-border bg-card px-3 py-2.5 text-xs text-muted-foreground"
    >
      <p>
        <strong className="font-semibold text-accent">{V8_STATUS.label}</strong>. {V8_STATUS.summary}
      </p>
      <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
        <Link href="/dashboard#track-record" className="text-foreground underline underline-offset-2">
          Chart track record
        </Link>
        <span>As of {V8_STATUS.asOf}</span>
      </p>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-foreground">The four studies</summary>
        <ul className="mt-1.5 space-y-1">
          {V8_STATUS.studies.map((study) => (
            <li key={study.name}>
              <span className="text-foreground">{study.name}</span>{' '}
              <span className="font-mono tabular-nums">{study.date}</span>. {study.verdict}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
