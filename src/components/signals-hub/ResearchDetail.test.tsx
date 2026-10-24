import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ResearchDetail } from './ResearchDetail';
import { RESEARCH_CATALOG } from '@/content/research/catalog';

vi.mock('./LabLiveState', () => ({
  LabLiveState: ({ hypothesisIds }: { hypothesisIds: string[] }) => (
    <div data-testid="mock-lab-live-state">
      Mock LabLiveState: {hypothesisIds.join(', ')}
    </div>
  ),
}));

describe('ResearchDetail', () => {
  it('renders a catalog entry that has runs and trials with all section headings, trial line, one run row with date and commit, and back link', () => {
    const entry = RESEARCH_CATALOG.find((e) => e.id === 'rv-v1-revalidation');
    expect(entry).toBeDefined();
    if (!entry) throw new Error('rv-v1-revalidation entry not found in catalog');

    render(<ResearchDetail entry={entry} />);

    // Back link
    const backLink = screen.getByRole('link', { name: 'All signals and research' });
    expect(backLink).toBeInTheDocument();
    expect(backLink).toHaveAttribute('href', '/signals');

    // Page header title and description
    expect(
      screen.getByRole('heading', { name: 'Relative value rv-v1 re-validation' })
    ).toBeInTheDocument();
    expect(screen.getByText(entry.summary)).toBeInTheDocument();

    // Section headings
    expect(screen.getByRole('heading', { name: 'Method' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Trials' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Result' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Test runs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Research notes' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'References' })).toBeInTheDocument();

    // Trial line
    expect(
      screen.getByText(/12 trials: 12 strategy cells re-selected in both permutation steps/)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The program ledger stood at 2,161 after this study/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Program total today: 2,204/)).toBeInTheDocument();

    // One run row with its date and commit
    const commits = screen.getAllByText('ef4043a');
    expect(commits.length).toBeGreaterThan(0);
    expect(commits[0]).toBeInTheDocument();

    const dates = screen.getAllByText('2026-10-15');
    expect(dates.length).toBeGreaterThan(0);
    expect(dates[0]).toBeInTheDocument();

    expect(
      screen.getByText('Synthetic calibration run across four universe models')
    ).toBeInTheDocument();
  });

  it('an entry without trials shows the muted line', () => {
    const entry = RESEARCH_CATALOG.find((e) => e.id === 'records-paper-desk');
    expect(entry).toBeDefined();
    if (!entry) throw new Error('records-paper-desk entry not found in catalog');

    render(<ResearchDetail entry={entry} />);

    expect(
      screen.getByText('No trial count recorded for this entry.')
    ).toBeInTheDocument();
  });

  it('a lab entry renders LabLiveState', () => {
    const entry = RESEARCH_CATALOG.find((e) => e.id === 'lab-v4');
    expect(entry).toBeDefined();
    if (!entry) throw new Error('lab-v4 entry not found in catalog');

    render(<ResearchDetail entry={entry} />);

    expect(screen.getByRole('heading', { name: 'Live state' })).toBeInTheDocument();
    expect(screen.getByTestId('mock-lab-live-state')).toBeInTheDocument();
    expect(screen.getByText(/S1-1h, S2-1h/)).toBeInTheDocument();
  });
});
