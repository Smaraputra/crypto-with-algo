import type { Metadata } from 'next';
import { HowItWorksPage } from '@/components/marketing-v2';

export const metadata: Metadata = {
  title: 'How it works | CryptoWithAlgo',
  description:
    'Learn how to create an account, track coins, study trading costs, and follow our transparent research lab.',
};

export default function MarketingHowItWorksPage() {
  return <HowItWorksPage />;
}
