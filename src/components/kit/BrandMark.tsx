import React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { cn } from '@/lib/utils';

export type BrandMarkSize = 'sm' | 'md' | 'lg';

export interface BrandMarkProps {
  size?: BrandMarkSize;
  href?: string;
  className?: string;
}

const sizeConfig: Record<
  BrandMarkSize,
  { dimension: number; priority?: boolean; textClass: string; gapClass: string }
> = {
  sm: { dimension: 20, priority: false, textClass: 'text-[15px]', gapClass: 'gap-2' },
  md: { dimension: 24, priority: true, textClass: 'text-[18px]', gapClass: 'gap-2.5' },
  lg: { dimension: 28, priority: true, textClass: 'text-[22px]', gapClass: 'gap-3' },
};

export const BrandMark: React.FC<BrandMarkProps> = ({
  size = 'md',
  href,
  className,
}) => {
  const config = sizeConfig[size];

  const content = (
    <>
      <Image
        src="/logo.png"
        alt=""
        width={config.dimension}
        height={config.dimension}
        priority={config.priority}
      />
      <span>CryptoWithAlgo</span>
    </>
  );

  const classes = cn(
    'inline-flex items-center font-sans font-semibold tracking-[-0.01em] text-foreground select-none whitespace-nowrap',
    config.gapClass,
    config.textClass,
    href && 'min-h-[44px] transition-opacity hover:opacity-90',
    className
  );

  if (href) {
    return (
      <Link href={href} aria-label="CryptoWithAlgo home" className={classes}>
        {content}
      </Link>
    );
  }

  return <span className={classes}>{content}</span>;
};
