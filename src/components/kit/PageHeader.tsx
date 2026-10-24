import React from 'react';
import { cn } from '@/lib/utils';

export interface PageHeaderProps {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  description,
  actions,
  className,
}) => {
  return (
    <header className={cn('flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div className="min-w-0 flex-1">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em] text-foreground">
          {title}
        </h1>
        {description && (
          <p className="text-[14px] text-muted-foreground max-w-[62ch] mt-1.5 leading-relaxed">
            {description}
          </p>
        )}
      </div>
      {actions && <div className="flex items-center gap-3 w-full sm:w-auto shrink-0">{actions}</div>}
    </header>
  );
};
