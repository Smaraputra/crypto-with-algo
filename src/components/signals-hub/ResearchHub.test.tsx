import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResearchHub } from './ResearchHub';
import {
  RESEARCH_CATALOG,
  RESEARCH_FAMILIES,
  LEDGER_TOTAL,
  type ResearchFamily,
} from '@/content/research/catalog';

const mockReplace = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: mockReplace,
    push: vi.fn(),
  }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock('./LabLiveState', () => ({
  LabLiveState: () => <div data-testid="mock-lab-live-state" />,
}));

describe('ResearchHub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  it('renders a heading per family present in the catalog', () => {
    render(<ResearchHub />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Signals and research' })
    ).toBeInTheDocument();

    const familiesWithEntries = new Set(RESEARCH_CATALOG.map((e) => e.family));
    for (const fam of familiesWithEntries) {
      const familyInfo = RESEARCH_FAMILIES[fam as ResearchFamily];
      expect(
        screen.getByRole('heading', { level: 2, name: familyInfo.label })
      ).toBeInTheDocument();
    }
  });

  it('shows the formatted ledger line matching LEDGER_TOTAL trials', () => {
    render(<ResearchHub />);

    const expectedNumber = LEDGER_TOTAL.toLocaleString('en-US');
    const ledgerLine = screen.getByText(new RegExp(`${expectedNumber} trials`));
    expect(ledgerLine).toBeInTheDocument();
    expect(ledgerLine.textContent).toContain(
      `${expectedNumber} trials recorded in the ledger`
    );
  });

  it('choosing Status "Rejected" updates URL and leaves only rejected entries', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ResearchHub />);

    const rejectedCount = RESEARCH_CATALOG.filter(
      (e) => e.status === 'rejected'
    ).length;
    expect(rejectedCount).toBeGreaterThan(0);

    const rejectedOption = screen.getByRole('radio', { name: 'Rejected' });
    await user.click(rejectedOption);

    expect(mockReplace).toHaveBeenCalledWith('/signals?status=rejected', {
      scroll: false,
    });

    mockSearchParams = new URLSearchParams('status=rejected');
    rerender(<ResearchHub />);

    // Count cards against rejected entries in catalog
    const articles = screen.getAllByRole('article');
    expect(articles).toHaveLength(rejectedCount);

    // Verify non-rejected entry is not displayed
    const underTestEntry = RESEARCH_CATALOG.find((e) => e.status === 'under-test');
    if (underTestEntry) {
      expect(screen.queryByText(underTestEntry.name)).not.toBeInTheDocument();
    }
  });

  it('renders empty state and "Clear filters" resets filter view', async () => {
    const user = userEvent.setup();
    // Filter by a combination that produces 0 matches
    mockSearchParams = new URLSearchParams('status=void&family=forward-lab');
    const { rerender } = render(<ResearchHub />);

    expect(
      screen.getByText('No entries match these filters.')
    ).toBeInTheDocument();

    const clearButton = screen.getByRole('button', { name: 'Clear filters' });
    expect(clearButton).toBeInTheDocument();

    await user.click(clearButton);
    expect(mockReplace).toHaveBeenCalledWith('/signals', { scroll: false });

    mockSearchParams = new URLSearchParams();
    rerender(<ResearchHub />);

    expect(
      screen.queryByText('No entries match these filters.')
    ).not.toBeInTheDocument();
  });
});
