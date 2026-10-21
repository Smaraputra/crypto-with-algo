import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  EvidenceTag,
  labStatusKind,
  type EvidenceKind,
} from './EvidenceTag';

describe('EvidenceTag', () => {
  const kinds: Array<{ kind: EvidenceKind; text: string }> = [
    { kind: 'untested', text: 'Untested' },
    { kind: 'no-edge', text: 'Measured: no edge' },
    { kind: 'under-test', text: 'Under test' },
    { kind: 'validated', text: 'Validated' },
    { kind: 'not-shown', text: 'Not shown' },
    { kind: 'not-started', text: 'Not started' },
    { kind: 'context', text: 'Context, not a signal' },
  ];

  it.each(kinds)('renders $kind as "$text"', ({ kind, text }) => {
    render(<EvidenceTag kind={kind} />);
    const el = screen.getByTestId('evidence-tag');
    expect(el).toHaveTextContent(text);
    expect(el).toHaveClass('rounded-sm', 'border', 'border-border');
    expect(el).not.toHaveClass('rounded-full');
  });

  describe('labStatusKind', () => {
    it('maps lab status strings correctly', () => {
      expect(labStatusKind('not_started')).toBe('not-started');
      expect(labStatusKind('under_test')).toBe('under-test');
      expect(labStatusKind('validated')).toBe('validated');
      expect(labStatusKind('not_shown')).toBe('not-shown');
    });
  });
});
