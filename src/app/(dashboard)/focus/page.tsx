import type { Metadata } from 'next';
import { CoinStudy } from '@/components/coin';

export const metadata: Metadata = {
  title: 'Coin study | CryptoWithAlgo',
};

const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}USDT$/;

export interface FocusPageProps {
  searchParams?: Promise<{ symbol?: string | string[] }> | { symbol?: string | string[] };
}

export default async function FocusPage(props: FocusPageProps) {
  const resolved = props.searchParams ? await Promise.resolve(props.searchParams) : undefined;
  const rawSymbol = typeof resolved?.symbol === 'string'
    ? resolved.symbol
    : Array.isArray(resolved?.symbol)
      ? resolved.symbol[0]
      : undefined;

  const validSymbol = rawSymbol && SYMBOL_PATTERN.test(rawSymbol) ? rawSymbol : undefined;

  return <CoinStudy symbol={validSymbol} />;
}
