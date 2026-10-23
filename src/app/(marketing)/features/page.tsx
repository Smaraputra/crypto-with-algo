import type { Metadata } from 'next';
import { FeaturesPage } from '@/components/marketing-v2';

export const metadata: Metadata = {
  title: 'Features | CryptoWithAlgo',
  description:
    'Explore live market tracking, research lab hypotheses, portfolio management, and trading cost tools.',
};

export default function MarketingFeaturesPage() {
  return <FeaturesPage />;
}
