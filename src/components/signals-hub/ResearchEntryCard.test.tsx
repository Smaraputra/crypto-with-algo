import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResearchEntryCard } from './ResearchEntryCard';
import type { ResearchEntry, ResearchStatus } from '@/content/research/catalog';

vi.mock('./LabLiveState', () => ({
  LabLiveState: () => <div data-testid="mock-lab-live-state">Mock LabLiveState</div>,
}));

const mockEntry: ResearchEntry = {
  id: 'test-entry-1',
  name: 'Test Signal Strategy',
  family: 'price-score',
  status: 'rejected',
  period: 'Run 2026-10-08',
  summary: 'A test summary for the entry.',
  steps: ['Gather historical candles', 'Run cross-validation on 4h bars'],
  result: 'No statistically significant edge after fees.',
  figures: [
    {
      label: 'Sample size',
      value: '2,500 bars',
      source: { path: 'scripts/test.ts', line: 10 },
    },
    {
      label: 'Sharpe ratio',
      value: '-0.15',
      source: { path: 'scripts/test.ts', line: 20 },
    },
  ],
  research: ['Cost drag exceeds gross margin', 'High sensitivity to slippage'],
  references: [
    {
      label: 'Initial implementation',
      path: 'src/lib/strategy.ts',
      pr: 123,
      date: '2026-09-15',
    },
  ],
  symbols: ['BTCUSDT'],
  labHypotheses: ['L1-8h'],
};

describe('ResearchEntryCard', () => {
  it('is collapsed by default with aria-expanded="false"', () => {
    render(<ResearchEntryCard entry={mockEntry} />);

    const button = screen.getByRole('button', { expanded: false });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');

    expect(screen.getByText('Test Signal Strategy')).toBeInTheDocument();
    expect(screen.getByText('Run 2026-10-08')).toBeInTheDocument();
    expect(screen.getByText('A test summary for the entry.')).toBeInTheDocument();

    // Expanded sections should not be visible
    expect(screen.queryByRole('heading', { name: 'Steps' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Result' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Research' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'References' })).not.toBeInTheDocument();
  });

  it('click expands and shows Steps, Result, figures, Research, References and Coins', async () => {
    const user = userEvent.setup();
    render(<ResearchEntryCard entry={mockEntry} />);

    const button = screen.getByRole('button', { expanded: false });
    await user.click(button);

    expect(button).toHaveAttribute('aria-expanded', 'true');

    // Steps
    expect(screen.getByRole('heading', { name: 'Steps' })).toBeInTheDocument();
    expect(screen.getByText('Gather historical candles')).toBeInTheDocument();
    expect(screen.getByText('Run cross-validation on 4h bars')).toBeInTheDocument();

    // Result & Figures
    expect(screen.getByRole('heading', { name: 'Result' })).toBeInTheDocument();
    expect(
      screen.getByText('No statistically significant edge after fees.')
    ).toBeInTheDocument();
    expect(screen.getByText('Sample size')).toBeInTheDocument();
    expect(screen.getByText('2,500 bars')).toBeInTheDocument();
    expect(screen.getByText('Sharpe ratio')).toBeInTheDocument();
    expect(screen.getByText('-0.15')).toBeInTheDocument();

    // Research
    expect(screen.getByRole('heading', { name: 'Research' })).toBeInTheDocument();
    expect(screen.getByText('Cost drag exceeds gross margin')).toBeInTheDocument();
    expect(screen.getByText('High sensitivity to slippage')).toBeInTheDocument();

    // References
    expect(screen.getByRole('heading', { name: 'References' })).toBeInTheDocument();
    expect(screen.getByText('Initial implementation')).toBeInTheDocument();
    expect(screen.getByText('src/lib/strategy.ts')).toBeInTheDocument();
    expect(screen.getByText('PR #123')).toBeInTheDocument();
    expect(screen.getByText('2026-09-15')).toBeInTheDocument();

    // Coins link to /focus?symbol=BTCUSDT
    const coinLink = screen.getByRole('link', { name: 'BTC' });
    expect(coinLink).toHaveAttribute('href', '/focus?symbol=BTCUSDT');

    // LabLiveState rendered
    expect(screen.getByTestId('mock-lab-live-state')).toBeInTheDocument();
  });

  it('maps each status to the right chip text', () => {
    const statuses: Array<{ status: ResearchStatus; expectedText: string }> = [
      { status: 'under-test', expectedText: 'Under test' },
      { status: 'rejected', expectedText: 'Rejected' },
      { status: 'no-edge', expectedText: 'No edge (measured)' },
      { status: 'not-registered', expectedText: 'Not registered' },
      { status: 'void', expectedText: 'Void' },
      { status: 'descriptive', expectedText: 'Descriptive' },
      { status: 'validated', expectedText: 'Validated' },
    ];

    for (const { status, expectedText } of statuses) {
      const entry: ResearchEntry = {
        ...mockEntry,
        id: `test-${status}`,
        status,
      };
      const { unmount } = render(<ResearchEntryCard entry={entry} />);
      expect(screen.getByText(expectedText)).toBeInTheDocument();
      unmount();
    }
  });
});
