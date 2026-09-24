import { ContentLayout } from '@/components/marketing/ContentLayout';

/**
 * The blog has no posts yet, and says so.
 *
 * It previously rendered four hardcoded articles -- invented titles, invented
 * 2024-2025 dates, invented excerpts and read times -- on a public marketing
 * path. The cards were not clickable, there were no bodies, and no
 * `/blog/[slug]` route existed, so nothing could have been read even if a
 * visitor tried. Fabricated content presented as a real publication record is
 * worse than an empty page, so the page is now honest about being empty.
 *
 * Adding a post means adding real content plus a `[slug]` route; this file is
 * not the place to reintroduce placeholders.
 */
export default function BlogPage() {
  return (
    <ContentLayout
      title="Blog"
      subtitle="Notes on the signal engine, the research programme, and what we are measuring."
    >
      <div className="rounded-lg border border-border bg-muted/30 p-8 text-center">
        <h2 className="font-semibold">No posts yet</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          Nothing has been published here yet. The{' '}
          <a href="/docs" className="underline hover:text-foreground">
            documentation
          </a>{' '}
          covers how the platform works in the meantime.
        </p>
      </div>
    </ContentLayout>
  );
}
