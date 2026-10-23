import React from 'react';
import { Panel } from '@/components/kit/Panel';
import { EvidenceChip } from '@/components/kit/EvidenceChip';
import { useCrossSectionalLatest, type CrossSectionalLatestResponse } from '@/hooks/useSignals';
import { cn } from '@/lib/utils';

export interface RejectedRuleProps {
  data?: CrossSectionalLatestResponse | null;
  className?: string;
}

export const RejectedRule: React.FC<RejectedRuleProps> = ({
  data: propData,
  className,
}) => {
  const query = useCrossSectionalLatest();
  const data = propData !== undefined ? propData : query.data;

  const book = data?.book;
  const rule = data?.rule;

  return (
    <Panel
      as="section"
      aria-labelledby="group-heading-rejected"
      data-testid="rejected-rule"
      className={cn(className)}
    >
      <div className="mb-2">
        <h2 id="group-heading-rejected" className="m-0 text-base font-normal">
          <EvidenceChip kind="rejected" />
        </h2>
      </div>

      <div className="pt-1">
        <h3 className="font-semibold text-foreground text-[15px]">
          Relative value, 8 hours
        </h3>

        <p className="text-[14px] text-muted-foreground mt-1 leading-relaxed">
          Failed its re-validation on 15 October 2026. Its paper record keeps running as a public record.
        </p>

        {book?.equity && (
          <div className="flex flex-wrap gap-4 mt-3 pt-3 border-t border-line text-[14px]">
            {typeof book.equity.taker === 'number' && (
              <div>
                <span className="block text-[12px] text-muted-foreground">Taker equity</span>
                <span className="font-semibold text-foreground font-sans tabular-nums">
                  ${book.equity.taker.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            )}
            {typeof book.equity.maker === 'number' && (
              <div>
                <span className="block text-[12px] text-muted-foreground">Maker equity</span>
                <span className="font-semibold text-foreground font-sans tabular-nums">
                  ${book.equity.maker.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            )}
            {typeof rule?.startingEquity === 'number' && (
              <div>
                <span className="block text-[12px] text-muted-foreground">Starting equity</span>
                <span className="font-semibold text-foreground font-sans tabular-nums">
                  ${rule.startingEquity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
};
