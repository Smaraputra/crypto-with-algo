import { ContentLayout } from '@/components/marketing/ContentLayout';
import { PrivacyContent, PRIVACY_LAST_UPDATED } from '@/content/legal/PrivacyContent';

export default function PrivacyPage() {
  return (
    <ContentLayout
      title="Privacy Policy"
      subtitle={`Last updated: ${PRIVACY_LAST_UPDATED}`}
    >
      <div className="prose prose-sm max-w-none space-y-6 text-muted-foreground">
        <PrivacyContent />
      </div>
    </ContentLayout>
  );
}
