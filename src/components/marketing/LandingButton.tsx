'use client';

import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

const baseClasses =
  'group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-lg font-semibold transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50';

const sizeClasses = {
  default: 'h-10 px-5 text-sm',
  lg: 'h-12 px-8 text-base',
};

const variantClasses = {
  outline: 'border border-border text-foreground hover:text-background',
  solid: 'bg-accent text-background hover:bg-accent/90',
};

interface LandingButtonProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: 'outline' | 'solid';
  size?: 'default' | 'lg';
}

export const LandingButton = forwardRef<HTMLAnchorElement, LandingButtonProps>(
  (
    {
      className,
      variant = 'outline',
      size = 'default',
      children,
      href,
      ...props
    },
    ref
  ) => {
    return (
      <a
        ref={ref}
        href={href}
        className={cn(
          baseClasses,
          sizeClasses[size],
          variantClasses[variant],
          className
        )}
        {...props}
      >
        {/* Fill sweep for outline variant */}
        {variant === 'outline' && (
          <span
            aria-hidden="true"
            className="absolute inset-0 translate-y-full bg-accent transition-transform duration-300 ease-out group-hover:translate-y-0"
          />
        )}
        <span className="relative z-10 flex items-center gap-2">
          {children}
        </span>
      </a>
    );
  }
);

LandingButton.displayName = 'LandingButton';
