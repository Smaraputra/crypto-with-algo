import { ContentLayout } from '@/components/marketing/ContentLayout';

export default function TermsPage() {
  return (
    <ContentLayout
      title="Terms of Service"
      subtitle={`Last updated: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`}
    >
      <section className="prose prose-sm max-w-none text-muted-foreground">
        <p>Terms of service content to be added.</p>
      </section>
    </ContentLayout>
  );
}
