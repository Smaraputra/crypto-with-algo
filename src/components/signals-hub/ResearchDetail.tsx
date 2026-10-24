'use client';

import React from 'react';
import Link from 'next/link';
import {
  LEDGER_TOTAL,
  type ResearchEntry,
} from '@/content/research/catalog';
import { PageHeader } from '@/components/kit/PageHeader';
import { Panel } from '@/components/kit/Panel';
import { EvidenceChip } from '@/components/kit/EvidenceChip';
import { getStatusChipConfig } from './ResearchEntryCard';
import { LabLiveState } from './LabLiveState';
import { getBaseAsset } from '@/components/market-home/formatters';
import { cn } from '@/lib/utils';

export interface ResearchDetailProps {
  entry: ResearchEntry;
  className?: string;
}

export const ResearchDetail: React.FC<ResearchDetailProps> = ({
  entry,
  className,
}) => {
  const chipConfig = getStatusChipConfig(entry.status);

  const sortedRuns = [...(entry.runs ?? [])].sort((a, b) =>
    b.date.localeCompare(a.date)
  );

  const renderTrialsText = () => {
    if (!entry.trials) {
      return (
        <p className="text-[14px] text-muted-foreground leading-relaxed">
          No trial count recorded for this entry.
        </p>
      );
    }

    const { count, label, ledgerAfter } = entry.trials;
    const countFormatted = count.toLocaleString('en-US');
    const cleanLabel = label.replace(/\.+$/, '');
    const ledgerTotalFormatted = LEDGER_TOTAL.toLocaleString('en-US');

    let text = `${countFormatted} trials: ${cleanLabel}.`;
    if (ledgerAfter !== undefined) {
      text += ` The program ledger stood at ${ledgerAfter.toLocaleString('en-US')} after this study.`;
    }
    text += ` Program total today: ${ledgerTotalFormatted}.`;

    return (
      <p className="text-[14px] text-muted-foreground leading-relaxed font-sans">
        {text}
      </p>
    );
  };

  return (
    <div className={cn('space-y-6', className)}>
      {/* 1. Back link */}
      <div>
        <Link
          href="/signals"
          className="inline-flex items-center gap-1.5 min-h-[44px] text-[14px] font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline transition-colors duration-120"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10 12L6 8l4-4" />
          </svg>
          <span>All signals and research</span>
        </Link>
      </div>

      {/* 2. PageHeader */}
      <PageHeader
        title={entry.name}
        description={entry.summary}
        actions={
          <div className="flex items-center gap-2.5 flex-wrap">
            <EvidenceChip kind={chipConfig.kind} label={chipConfig.label} />
            <span className="text-[13px] text-muted-foreground font-sans tabular-nums whitespace-nowrap">
              {entry.period}
            </span>
          </div>
        }
      />

      {/* 3. Method */}
      <Panel title="Method">
        <ol className="list-decimal list-inside space-y-2 text-[14px] text-muted-foreground leading-relaxed">
          {entry.steps.map((step) => (
            <li key={step}>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </Panel>

      {/* 4. Trials */}
      <Panel title="Trials">
        {renderTrialsText()}
      </Panel>

      {/* 5. Result */}
      <Panel title="Result">
        <p className="text-[14px] text-muted-foreground leading-relaxed">
          {entry.result}
        </p>
        {entry.figures && entry.figures.length > 0 && (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-[14px] mt-4">
            {entry.figures.map((fig) => (
              <div
                key={fig.label}
                className="flex justify-between items-baseline border-b border-line py-1.5"
              >
                <dt className="text-muted-foreground">{fig.label}</dt>
                <dd className="font-semibold text-foreground font-sans tabular-nums text-right">
                  {fig.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Panel>

      {/* 6. Test runs */}
      <Panel title="Test runs">
        {sortedRuns.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-[14px] text-left border-collapse">
              <thead>
                <tr className="border-b border-line text-[13px] font-semibold text-muted-foreground">
                  <th scope="col" className="py-2.5 pr-4 whitespace-nowrap">Date</th>
                  <th scope="col" className="py-2.5 pr-4 min-w-[160px]">Run</th>
                  <th scope="col" className="py-2.5 pr-4 min-w-[120px]">Code</th>
                  <th scope="col" className="py-2.5 pr-4 min-w-[110px]">Data</th>
                  <th scope="col" className="py-2.5 pr-4 min-w-[160px]">Command</th>
                  <th scope="col" className="py-2.5 min-w-[200px]">Outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {sortedRuns.map((run) => (
                  <tr
                    key={`${run.date}-${run.label}-${run.commit ?? ''}-${run.command ?? ''}`}
                  >
                    <td className="py-3 pr-4 font-sans tabular-nums text-muted-foreground whitespace-nowrap align-top">
                      {run.date}
                    </td>
                    <td className="py-3 pr-4 font-semibold text-foreground align-top">
                      {run.label}
                    </td>
                    <td className="py-3 pr-4 align-top">
                      {run.commit || run.image ? (
                        <div className="flex flex-col gap-1 items-start">
                          {run.commit && (
                            <span className="px-1.5 py-0.5 rounded bg-muted text-[13px] text-muted-foreground font-sans break-all">
                              {run.commit}
                            </span>
                          )}
                          {run.image && (
                            <span className="px-1.5 py-0.5 rounded bg-muted text-[13px] text-muted-foreground font-sans break-all">
                              {run.image}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">n/a</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 align-top">
                      {run.dataset ? (
                        <span className="px-1.5 py-0.5 rounded bg-muted text-[13px] text-muted-foreground font-sans break-all">
                          {run.dataset}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">n/a</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 align-top">
                      {run.command ? (
                        <span className="px-1.5 py-0.5 rounded bg-muted text-[13px] text-muted-foreground font-sans break-all">
                          {run.command}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">n/a</span>
                      )}
                    </td>
                    <td className="py-3 align-top text-muted-foreground leading-relaxed">
                      {run.outcome ? (
                        run.outcome
                      ) : (
                        <span className="text-muted-foreground">n/a</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[14px] text-muted-foreground leading-relaxed">
            No test runs recorded for this entry.
          </p>
        )}
      </Panel>

      {/* 7. Live state */}
      {entry.labHypotheses && entry.labHypotheses.length > 0 && (
        <Panel title="Live state">
          <LabLiveState hypothesisIds={entry.labHypotheses} />
        </Panel>
      )}

      {/* 8. Research notes */}
      {entry.research && entry.research.length > 0 && (
        <Panel title="Research notes">
          <ul className="list-disc list-inside space-y-2 text-[14px] text-muted-foreground leading-relaxed">
            {entry.research.map((item) => (
              <li key={item}>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* 9. References */}
      {entry.references && entry.references.length > 0 && (
        <Panel title="References">
          <ul className="space-y-2.5 text-[14px] text-muted-foreground">
            {entry.references.map((ref) => (
              <li
                key={`${ref.label}-${ref.path ?? ''}-${ref.pr ?? ''}-${ref.date ?? ''}`}
                className="flex flex-wrap items-baseline gap-2"
              >
                <span className="font-medium text-foreground">
                  {ref.label}
                </span>
                {ref.path && (
                  <span className="px-1.5 py-0.5 rounded bg-muted text-[13px] text-muted-foreground font-sans break-all">
                    {ref.path}
                  </span>
                )}
                {ref.pr && (
                  <span className="text-[13px] text-muted-foreground font-sans tabular-nums">
                    PR #{ref.pr}
                  </span>
                )}
                {ref.date && (
                  <span className="text-[13px] text-muted-foreground font-sans tabular-nums">
                    {ref.date}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* 10. Coins */}
      {entry.symbols && entry.symbols.length > 0 && (
        <Panel title="Coins">
          <div className="flex flex-wrap items-center gap-2">
            {entry.symbols.map((sym) => (
              <Link
                key={sym}
                href={`/focus?symbol=${encodeURIComponent(sym)}`}
                className="inline-flex items-center min-h-[44px] px-3.5 py-1 text-[13px] font-semibold text-foreground rounded-[8px] bg-muted/60 hover:bg-muted hover:border-foreground border border-edge transition-colors duration-120 focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px] focus-visible:outline"
              >
                {getBaseAsset(sym)}
              </Link>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
};
