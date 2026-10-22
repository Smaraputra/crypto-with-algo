import type { LabStatus } from '@/lib/signals/lab/view';
import { cn } from '@/lib/utils';

export type EvidenceKind =
  | 'untested'
  | 'no-edge'
  | 'under-test'
  | 'validated'
  | 'not-shown'
  | 'not-started'
  | 'context';

export interface EvidenceTagProps {
  kind: EvidenceKind;
  className?: string;
}

export const EVIDENCE_TEXT: Record<EvidenceKind, string> = {
  untested: 'Untested',
  'no-edge': 'Measured: no edge',
  'under-test': 'Under test',
  validated: 'Validated',
  'not-shown': 'Not shown',
  'not-started': 'Not started',
  context: 'Context, not a signal',
};

export function labStatusKind(status: LabStatus): EvidenceKind {
  switch (status) {
    case 'not_started':
      return 'not-started';
    case 'under_test':
      return 'under-test';
    case 'validated':
      return 'validated';
    case 'not_shown':
      return 'not-shown';
    default:
      return 'not-started';
  }
}

export function EvidenceTag({ kind, className }: EvidenceTagProps) {
  const text = EVIDENCE_TEXT[kind] ?? kind;

  return (
    <span
      data-testid="evidence-tag"
      className={cn(
        'inline-flex items-center rounded-sm border border-border px-1.5 py-0.5 text-xs text-muted-foreground',
        className
      )}
    >
      {text}
    </span>
  );
}
