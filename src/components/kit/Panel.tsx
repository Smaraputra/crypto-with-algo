import React from 'react';
import { cn } from '@/lib/utils';

export interface PanelProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  as?: 'section' | 'div';
  title?: string;
  action?: React.ReactNode;
  level?: 2 | 3;
  children?: React.ReactNode;
  className?: string;
}

export const Panel: React.FC<PanelProps> = ({
  as = 'section',
  title,
  action,
  level = 2,
  children,
  className,
  ...rest
}) => {
  const Component = as;
  const Heading = level === 3 ? 'h3' : 'h2';

  return (
    <Component
      {...rest}
      className={cn('bg-card rounded-panel p-5 sm:p-6', className)}
    >
      {(title || action) && (
        <div className="flex items-center justify-between gap-4 mb-4">
          {title ? (
            <Heading className="text-[16px] font-semibold text-ink-2 leading-none">
              {title}
            </Heading>
          ) : (
            <span />
          )}
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </Component>
  );
};

