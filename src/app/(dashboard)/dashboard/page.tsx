import type { Metadata } from 'next';
import { MarketHome } from '@/components/market-home';

export const metadata: Metadata = {
  title: 'Market | CryptoWithAlgo',
};

export default function DashboardPage() {
  return <MarketHome />;
}
