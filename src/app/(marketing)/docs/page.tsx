import type { Metadata } from 'next';
import { DocsPage } from '@/components/marketing-v2';

export const metadata: Metadata = {
  title: 'Documentation | CryptoWithAlgo',
  description:
    'Documentation for getting started, understanding platform tools, and data limitations.',
};

export default function MarketingDocsPage() {
  return <DocsPage />;
}
