import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ResearchDetailPage, { generateMetadata, generateStaticParams } from './page';
import { RESEARCH_CATALOG } from '@/content/research/catalog';

const mockNotFound = vi.fn();
vi.mock('next/navigation', () => ({
  notFound: () => {
    mockNotFound();
    return null;
  },
}));

vi.mock('@/components/signals-hub', () => ({
  ResearchDetail: ({ entry }: { entry: { name: string } }) => (
    <div data-testid="mock-research-detail">
      <h1>{entry.name}</h1>
    </div>
  ),
}));

describe('ResearchDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders entry name for a known id', async () => {
    const knownEntry = RESEARCH_CATALOG[0];
    const pageJsx = await ResearchDetailPage({
      params: Promise.resolve({ id: knownEntry.id }),
    });

    render(pageJsx);

    expect(screen.getByTestId('mock-research-detail')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: knownEntry.name })
    ).toBeInTheDocument();
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('calls notFound for an unknown id', async () => {
    await ResearchDetailPage({
      params: Promise.resolve({ id: 'does-not-exist' }),
    });

    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it('generateMetadata sets title to "{entry.name} | CryptoWithAlgo" for a known id', async () => {
    const knownEntry = RESEARCH_CATALOG[0];
    const meta = await generateMetadata({
      params: Promise.resolve({ id: knownEntry.id }),
    });

    expect(meta.title).toBe(`${knownEntry.name} | CryptoWithAlgo`);
  });

  it('generateMetadata sets fallback title for an unknown id', async () => {
    const meta = await generateMetadata({
      params: Promise.resolve({ id: 'does-not-exist' }),
    });

    expect(meta.title).toBe('Page not found | CryptoWithAlgo');
  });

  it('generateStaticParams returns an array of all catalog ids', () => {
    const params = generateStaticParams();
    expect(params).toHaveLength(RESEARCH_CATALOG.length);
    expect(params).toEqual(RESEARCH_CATALOG.map((entry) => ({ id: entry.id })));
  });
});
