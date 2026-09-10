import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DisciplineBanner } from './DisciplineBanner';
import type { DisciplineNudge } from '@/lib/discipline';

const nudges: DisciplineNudge[] = [
  { rule: 'loss_cooldown', severity: 'warning', message: '3 consecutive losses.' },
  { rule: 'overtrading', severity: 'info', message: '8 trades logged today.' },
];

describe('DisciplineBanner', () => {
  it('renders a row per nudge', () => {
    render(<DisciplineBanner nudges={nudges} />);

    expect(screen.getByTestId('discipline-banner')).toBeInTheDocument();
    expect(screen.getByTestId('discipline-nudge-loss_cooldown')).toHaveTextContent(
      '3 consecutive losses.'
    );
    expect(screen.getByTestId('discipline-nudge-overtrading')).toHaveTextContent(
      '8 trades logged today.'
    );
  });

  it('renders nothing without nudges', () => {
    const { container } = render(<DisciplineBanner nudges={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
