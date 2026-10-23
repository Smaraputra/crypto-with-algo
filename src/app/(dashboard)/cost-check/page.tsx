import type { Metadata } from 'next';
import { CostCheckClient } from '@/components/cost-check-v2/CostCheckClient';

export const metadata: Metadata = {
  title: 'Cost Check | CryptoWithAlgo',
};

export default function CostCheckPage() {
  return <CostCheckClient />;
}
