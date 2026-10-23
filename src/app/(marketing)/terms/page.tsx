import { ContentLayout } from '@/components/marketing/ContentLayout';
import { TermsContent, TERMS_LAST_UPDATED } from '@/content/legal/TermsContent';

export default function TermsPage() {
  return (
    <ContentLayout
      title="Terms of Service"
      subtitle={`Last updated: ${TERMS_LAST_UPDATED}`}
    >
      <div className="prose prose-sm max-w-none space-y-6 text-muted-foreground">
        <TermsContent />
      </div>
    </ContentLayout>
  );
}
