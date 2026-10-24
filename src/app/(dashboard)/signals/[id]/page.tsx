import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RESEARCH_CATALOG } from '@/content/research/catalog';
import { ResearchDetail } from '@/components/signals-hub';

interface PageProps {
  params: Promise<{ id: string }> | { id: string };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const resolvedParams = await params;
  const entry = RESEARCH_CATALOG.find((e) => e.id === resolvedParams.id);
  if (!entry) {
    return {
      title: 'Page not found | CryptoWithAlgo',
    };
  }
  return {
    title: `${entry.name} | CryptoWithAlgo`,
  };
}

export function generateStaticParams(): Array<{ id: string }> {
  return RESEARCH_CATALOG.map((entry) => ({ id: entry.id }));
}

export default async function ResearchDetailPage({ params }: PageProps) {
  const resolvedParams = await params;
  const entry = RESEARCH_CATALOG.find((e) => e.id === resolvedParams.id);
  if (!entry) {
    notFound();
  }
  return <ResearchDetail entry={entry} />;
}
