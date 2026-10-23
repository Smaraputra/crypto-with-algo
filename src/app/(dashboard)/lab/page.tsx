import type { Metadata } from 'next';
import { LabRecord } from '@/components/lab';

export const metadata: Metadata = {
  title: 'The lab record | CryptoWithAlgo',
};

export default function LabPage() {
  return <LabRecord />;
}
