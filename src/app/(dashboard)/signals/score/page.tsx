import type { Metadata } from 'next';
import { ScorePage } from '@/components/score';

export const metadata: Metadata = {
  title: 'Price score | CryptoWithAlgo',
};

export default function SignalsScorePage() {
  return <ScorePage />;
}
