import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EvidenceChip, type EvidenceKind } from './EvidenceChip';

const ALL_KINDS: EvidenceKind[] = [
  'untested',
  'no-edge',
  'under-test',
  'validated',
  'rejected',
  'context',
  'not-started',
];

describe('EvidenceChip', () => {
  it('each kind renders its default label', () => {
    const expectedLabels: Record<EvidenceKind, string> = {
      untested: 'Untested',
      'no-edge': 'No edge (measured)',
      'under-test': 'Under test',
      validated: 'Validated',
      rejected: 'Rejected',
      context: 'Context',
      'not-started': 'Not started',
    };

    for (const kind of ALL_KINDS) {
      const { unmount } = render(<EvidenceChip kind={kind} />);
      expect(screen.getByText(expectedLabels[kind])).toBeInTheDocument();
      unmount();
    }
  });

  it('href renders a link with that href', () => {
    render(<EvidenceChip kind="validated" href="/lab/details" />);
    const link = screen.getByRole('link', { name: /validated/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/lab/details');
  });

  it('only under-test has the brand-line class', () => {
    for (const kind of ALL_KINDS) {
      const { container, unmount } = render(<EvidenceChip kind={kind} />);
      const hasBrandLine = container.innerHTML.includes('brand-line');

      if (kind === 'under-test') {
        expect(hasBrandLine).toBe(true);
      } else {
        expect(hasBrandLine).toBe(false);
      }
      unmount();
    }
  });

  it('a custom label overrides the default', () => {
    render(<EvidenceChip kind="under-test" label="Custom Status" />);
    expect(screen.getByText('Custom Status')).toBeInTheDocument();
    expect(screen.queryByText('Under test')).not.toBeInTheDocument();
  });
});
