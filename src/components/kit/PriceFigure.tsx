import React from 'react';
import { cn } from '@/lib/utils';

export type PriceFigureSize = 'hero' | 'large' | 'medium';

export interface PriceFigureChange {
  value: string;
  direction: 'up' | 'down' | 'flat';
}

export interface PriceFigureProps {
  value: string;
  change?: PriceFigureChange;
  changeLabel?: boolean | string;
  size?: PriceFigureSize;
  className?: string;
}

const SIZE_CLASSES: Record<PriceFigureSize, string> = {
  hero: 'text-[56px] sm:text-[80px]',
  large: 'text-[56px]',
  medium: 'text-[32px]',
};

export const PriceFigure: React.FC<PriceFigureProps> = ({
  value,
  change,
  changeLabel,
  size = 'large',
  className,
}) => {
  const labelSuffix = changeLabel
    ? typeof changeLabel === 'string'
      ? ` ${changeLabel}`
      : ' today'
    : '';

  return (
    <div className={cn('flex flex-col', className)}>
      <span
        data-testid="price-value"
        className={cn(
          'font-sans font-semibold tracking-[-0.02em] tabular-nums text-foreground leading-none',
          SIZE_CLASSES[size]
        )}
      >
        {value}
      </span>
      {change && (
        <span
          data-testid="price-change"
          className={cn(
            'text-[16px] font-semibold tabular-nums mt-1.5 leading-tight',
            change.direction === 'up' && 'text-up',
            change.direction === 'down' && 'text-down',
            change.direction === 'flat' && 'text-muted-foreground'
          )}
        >
          {change.value}
          {labelSuffix}
        </span>
      )}
    </div>
  );
};
