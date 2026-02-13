import { ContentLayout } from '@/components/marketing/ContentLayout';

export default function PrivacyPage() {
  return (
    <ContentLayout
      title="Privacy Policy"
      subtitle={`Last updated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`}
    >
      <section className="prose prose-sm max-w-none text-muted-foreground">
        <p>Privacy policy content to be added.</p>
      </section>
    </ContentLayout>
  );
}
