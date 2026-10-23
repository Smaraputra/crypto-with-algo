import type { Metadata } from 'next';
import { BacktestScreen } from '@/components/backtest-v2';

export const metadata: Metadata = {
  title: 'Backtest | CryptoWithAlgo',
};

export default function BacktestPage() {
  return <BacktestScreen />;
}
