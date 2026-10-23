'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Panel } from '@/components/kit/Panel';
import { EvidenceChip, type EvidenceKind } from '@/components/kit/EvidenceChip';
import { useSignalLab } from '@/hooks/useSignalLab';
import { useSignalLabV2 } from '@/hooks/useSignalLabV2';
import { useSignalLabV3 } from '@/hooks/useSignalLabV3';
import { useSignalLabV4 } from '@/hooks/useSignalLabV4';
import { coinEvidence, type CoinPosition } from '@/lib/signals/lab/coin-evidence';
import { getHypothesisDisplayName } from '@/components/lab/HypothesisRow';
import { getBaseAsset } from '@/components/market-home/formatters';

export interface CoinEvidencePanelProps {
  symbol: string;
  className?: string;
}

export function formatCoinPosition(pos: CoinPosition): string {
  switch (pos.kind) {
    case 'not_in_universe':
      return "Not in this lab's coins";
    case 'no_bar':
      return 'No bar yet';
    case 'cash':
      return 'In cash';
    case 'flat':
      return 'No position';
    case 'long':
    case 'short': {
      const base = pos.kind === 'long' ? 'Holding long' : 'Holding short';
      const parts: string[] = [base];
      if (typeof pos.weight === 'number' && Number.isFinite(pos.weight)) {
        parts.push(pos.weight.toFixed(3));
      }
      if (typeof pos.until === 'number' && Number.isFinite(pos.until)) {
        const d = new Date(pos.until);
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        parts.push(`until ${hh}:${mm} UTC`);
      }
      return parts.join(' ');
    }
  }
}

export const CoinEvidencePanel: React.FC<CoinEvidencePanelProps> = ({ symbol, className }) => {
  const [expanded, setExpanded] = useState<boolean>(false);

  const { data: v1 } = useSignalLab();
  const { data: v2 } = useSignalLabV2();
  const { data: v3 } = useSignalLabV3();
  const { data: v4 } = useSignalLabV4(symbol);

  const rows = coinEvidence(symbol, { v1, v2, v3, v4 });

  const hasValidated = rows.some((r) => r.status === 'validated');
  const hasUnderTest = rows.some((r) => r.status === 'under_test');
  const chipKind: EvidenceKind = hasValidated
    ? 'validated'
    : hasUnderTest
      ? 'under-test'
      : 'not-started';

  const baseAsset = getBaseAsset(symbol);
  const visibleRows = expanded ? rows : rows.slice(0, 4);
  const canExpand = rows.length > 4;

  return (
    <Panel
      title={`Best evidence for ${baseAsset}`}
      action={<EvidenceChip kind={chipKind} href="/lab" />}
      className={className}
    >
      <div className="divide-y divide-line">
        {visibleRows.map((row) => {
          const displayName = getHypothesisDisplayName(row.candidate, row.timeframe, row.id);
          const positionText = formatCoinPosition(row.position);

          return (
            <div
              key={row.id}
              data-testid={`evidence-row-${row.id}`}
              className="py-3 first:pt-0 last:pb-0 flex flex-col gap-1 text-[14px]"
            >
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <div className="flex items-baseline gap-2">
                  <span className="font-semibold text-foreground text-[15px]">{displayName}</span>
                  <span className="text-[13px] text-muted-foreground font-sans tabular-nums">
                    {row.id}
                  </span>
                </div>
                <span className="text-[13px] font-sans tabular-nums text-muted-foreground">
                  Evidence {row.e.toFixed(1)} of {row.threshold}
                </span>
              </div>

              <div className="text-[13px] text-muted-foreground">{positionText}</div>
            </div>
          );
        })}
      </div>

      {canExpand && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="min-h-[44px] h-[44px] px-3 inline-flex items-center justify-center rounded-[8px] text-[13px] font-semibold text-foreground hover:bg-muted border border-edge bg-card transition-colors duration-120 cursor-pointer w-full mt-3 focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px]"
        >
          Show all {rows.length}
        </button>
      )}

      <div className="mt-4 pt-3 border-t border-line flex flex-col gap-2">
        <Link
          href="/lab"
          className="text-[14px] font-semibold text-foreground hover:underline inline-flex items-center min-h-[44px] py-1 focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[2px]"
        >
          Open the lab record
        </Link>

        {!hasValidated && (
          <p className="text-[13px] text-muted-foreground leading-normal">
            None of these ideas is validated. Positions are paper records, not advice.
          </p>
        )}
      </div>
    </Panel>
  );
};
