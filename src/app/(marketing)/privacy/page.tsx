import type { Metadata } from 'next';
import { LegalPage } from '@/components/marketing-v2';
import { PrivacyContent, PRIVACY_LAST_UPDATED } from '@/content/legal/PrivacyContent';

export const metadata: Metadata = {
  title: 'Privacy Policy | CryptoWithAlgo',
  description:
    'Privacy policy, data retention details, and privacy rights for CryptoWithAlgo users.',
};

export default function MarketingPrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" lastUpdated={PRIVACY_LAST_UPDATED}>
      <PrivacyContent />
    </LegalPage>
  );
}
