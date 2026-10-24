import type { Metadata } from 'next';
import { BlogPage } from '@/components/marketing-v2';

export const metadata: Metadata = {
  title: 'Blog | CryptoWithAlgo',
  description:
    'Research updates, experiment results, and product notes from the CryptoWithAlgo team.',
};

export default function MarketingBlogPage() {
  return <BlogPage />;
}
