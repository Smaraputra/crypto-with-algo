import type { Metadata } from 'next';
import { HomePage } from '@/components/marketing-v2';

export const metadata: Metadata = {
  title: 'Crypto market tracker with an open research lab | CryptoWithAlgo',
  description:
    'Track live crypto prices, study a coin with its trading costs, and follow an open record of trading ideas tested on live data.',
};

export default function MarketingHomePage() {
  return <HomePage />;
}
