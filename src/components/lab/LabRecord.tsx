'use client';

import React from 'react';
import { useSignalLab } from '@/hooks/useSignalLab';
import { useSignalLabV2 } from '@/hooks/useSignalLabV2';
import { useSignalLabV3 } from '@/hooks/useSignalLabV3';
import { useSignalLabV4 } from '@/hooks/useSignalLabV4';
import { PageHeader } from '@/components/kit/PageHeader';
import { Panel } from '@/components/kit/Panel';
import { StateNotice } from '@/components/kit/StateNotice';
import { EvidenceChip } from '@/components/kit/EvidenceChip';
import { LabSummary } from './LabSummary';
import { HypothesisRow, type HypothesisViewLike } from './HypothesisRow';
import { RejectedRule } from './RejectedRule';
import { PriceScoreRecord } from './PriceScoreRecord';
import { ScoreTrackRecord } from './ScoreTrackRecord';

export interface LabRecordProps {
  className?: string;
}

export const LabRecord: React.FC<LabRecordProps> = ({ className }) => {
  const labV1 = useSignalLab();
  const labV2 = useSignalLabV2();
  const labV3 = useSignalLabV3();
  const labV4 = useSignalLabV4();

  const labQueries = [
    { key: 'lab-v1', query: labV1 },
    { key: 'lab-v2', query: labV2 },
    { key: 'lab-v3', query: labV3 },
    { key: 'lab-v4', query: labV4 },
  ];

  const allHypotheses: HypothesisViewLike[] = [];

  if (labV1.data?.hypotheses) {
    allHypotheses.push(
      ...labV1.data.hypotheses.map((h) => ({
        ...h,
        threshold: h.threshold ?? labV1.data?.threshold ?? 800,
      }))
    );
  }

  if (labV2.data?.hypotheses) {
    allHypotheses.push(
      ...labV2.data.hypotheses.map((h) => ({
        ...h,
        threshold: h.threshold ?? labV2.data?.threshold ?? 400,
        note: 'An effect this small is unlikely to be confirmed within 24 months.',
      }))
    );
  }

  if (labV3.data?.hypotheses) {
    allHypotheses.push(
      ...labV3.data.hypotheses.map((h) => ({
        ...h,
        threshold: h.threshold ?? labV3.data?.threshold ?? 200,
      }))
    );
  }

  if (labV4.data?.hypotheses) {
    allHypotheses.push(
      ...labV4.data.hypotheses.map((h) => ({
        ...h,
        threshold: h.threshold ?? labV4.data?.threshold ?? 800,
        note: 'Lost money on historical data. Recorded forward anyway, so the outcome is public.',
      }))
    );
  }

  const validatedHypotheses = allHypotheses.filter((h) => h.status === 'validated');
  const underTestHypotheses = allHypotheses.filter((h) => h.status === 'under_test');
  const notStartedHypotheses = allHypotheses.filter((h) => h.status === 'not_started');
  const notShownHypotheses = allHypotheses.filter((h) => h.status === 'not_shown');

  const validatedCount = validatedHypotheses.length;
  const underTestCount = underTestHypotheses.length;
  const notStartedCount = notStartedHypotheses.length;
  const rejectedCount = 1;

  const leadSentence =
    'Every trading idea we test is written down before it runs, then judged on live prices only.' +
    (validatedCount > 0 ? ` ${validatedCount} validated.` : '');

  const anyLoading = labQueries.some((q) => q.query.isLoading);
  const errorQueries = labQueries.filter((q) => q.query.isError);
  const allLoadedWithoutError = labQueries.every(
    (q) => !q.query.isLoading && !q.query.isError
  );
  const isEmpty = allLoadedWithoutError && allHypotheses.length === 0;

  return (
    <div className={className}>
      <PageHeader
        title="The lab record"
        description={leadSentence}
        className="mb-6 sm:mb-8"
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1.6fr] lg:grid-rows-[auto_auto_auto_1fr] gap-6 items-start">
        {/* Summary */}
        <div className="order-1 lg:col-start-1 lg:row-start-1">
          <LabSummary
            isLoading={anyLoading}
            counts={{
              validated: validatedCount,
              underTest: underTestCount,
              rejected: rejectedCount,
              notStarted: notStartedCount,
            }}
          />
        </div>

        {/* Groups */}
        <div className="order-2 lg:col-start-2 lg:row-start-1 lg:row-span-4 space-y-6">
          {anyLoading && (
            <StateNotice
              kind="loading"
              title="Loading the lab record."
            />
          )}

          {errorQueries.length > 0 && (
            <StateNotice
              kind="error"
              title="The lab record did not load."
              description="The lab service did not answer. Try again in a minute."
              action={
                <button
                  type="button"
                  onClick={() => {
                    for (const { query } of errorQueries) {
                      query.refetch();
                    }
                  }}
                  className="inline-flex items-center justify-center min-h-[44px] px-4 py-2 rounded-[12px] border border-edge bg-card text-foreground font-semibold text-[13px] hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring cursor-pointer"
                >
                  Try again
                </button>
              }
            />
          )}

          {isEmpty && (
            <StateNotice
              kind="empty"
              title="No ideas are being tested right now."
            />
          )}

          {!anyLoading && validatedHypotheses.length > 0 && (
            <Panel as="section" aria-labelledby="group-heading-validated" className="space-y-2">
              <div className="mb-2">
                <h2 id="group-heading-validated" className="m-0 text-base font-normal">
                  <EvidenceChip kind="validated" />
                </h2>
              </div>
              {validatedHypotheses.map((h) => (
                <HypothesisRow key={h.id} hypothesis={h} showChip={false} />
              ))}
            </Panel>
          )}

          {!anyLoading && underTestHypotheses.length > 0 && (
            <Panel as="section" aria-labelledby="group-heading-under-test" className="space-y-2">
              <div className="mb-2">
                <h2 id="group-heading-under-test" className="m-0 text-base font-normal">
                  <EvidenceChip kind="under-test" />
                </h2>
              </div>
              {underTestHypotheses.map((h) => (
                <HypothesisRow key={h.id} hypothesis={h} showChip={false} />
              ))}
            </Panel>
          )}

          {!anyLoading && notStartedHypotheses.length > 0 && (
            <Panel as="section" aria-labelledby="group-heading-not-started" className="space-y-2">
              <div className="mb-2">
                <h2 id="group-heading-not-started" className="m-0 text-base font-normal">
                  <EvidenceChip kind="not-started" />
                </h2>
              </div>
              {notStartedHypotheses.map((h) => (
                <HypothesisRow key={h.id} hypothesis={h} showChip={false} />
              ))}
            </Panel>
          )}

          {!anyLoading && notShownHypotheses.length > 0 && (
            <Panel as="section" aria-labelledby="group-heading-not-shown" className="space-y-2">
              <div className="mb-2">
                <h2 id="group-heading-not-shown" className="m-0 text-base font-normal">
                  <EvidenceChip kind="context" label="Not shown" />
                </h2>
              </div>
              {notShownHypotheses.map((h) => (
                <HypothesisRow key={h.id} hypothesis={h} showChip={false} />
              ))}
            </Panel>
          )}

          {!anyLoading && <RejectedRule />}
        </div>

        {/* Price score */}
        <div className="order-3 lg:col-start-1 lg:row-start-3">
          <PriceScoreRecord />
        </div>

        {/* Score track record */}
        <div className="order-3 lg:col-start-1 lg:row-start-4">
          <ScoreTrackRecord />
        </div>

        {/* How this works */}
        <div className="order-4 lg:col-start-1 lg:row-start-2">
          <Panel as="section" title="How this works">
            <p className="text-[14px] text-muted-foreground leading-relaxed">
              Each idea is fixed before it starts. Every bet it places on live data moves its evidence score. An idea counts as validated only if its evidence reaches its bar within 24 months of starting. Most ideas are expected to fail, and they stay on this page when they do.
            </p>
          </Panel>
        </div>
      </div>

      <footer className="mt-8 pt-4 border-t border-line text-[13px] text-muted-foreground flex justify-between items-center">
        <span>Market data from Binance</span>
      </footer>
    </div>
  );
};
