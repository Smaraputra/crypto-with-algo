import type { Metadata } from 'next';
import { AlertsScreen } from '@/components/alerts-v2';

export const metadata: Metadata = {
  title: 'Alerts | CryptoWithAlgo',
};

export default function AlertsPage() {
  return <AlertsScreen />;
}
