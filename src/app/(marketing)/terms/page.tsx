import type { Metadata } from 'next';
import { LegalPage } from '@/components/marketing-v2';
import { TermsContent, TERMS_LAST_UPDATED } from '@/content/legal/TermsContent';

export const metadata: Metadata = {
  title: 'Terms of Service | CryptoWithAlgo',
  description:
    'Terms of service, usage rules, and liability disclaimers for the CryptoWithAlgo platform.',
};

export default function MarketingTermsPage() {
  return (
    <LegalPage title="Terms of Service" lastUpdated={TERMS_LAST_UPDATED}>
      <TermsContent />
    </LegalPage>
  );
}
