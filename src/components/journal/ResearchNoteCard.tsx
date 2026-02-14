'use client';

import { Pin } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ResearchNote } from '@/types/research-note';

const CATEGORY_LABELS: Record<string, string> = {
  strategy: 'Strategy',
  concept: 'Concept',
  rule: 'Rule',
  checklist: 'Checklist',
  observation: 'Observation',
};

interface ResearchNoteCardProps {
  note: ResearchNote;
  isSelected: boolean;
  onClick: () => void;
}

export function ResearchNoteCard({ note, isSelected, onClick }: ResearchNoteCardProps) {
  return (
    <button
      type="button"
      className={cn(
        'w-full text-left rounded-md border p-2 text-xs transition-colors',
        isSelected
          ? 'border-primary bg-primary/10'
          : 'border-border hover:bg-muted/50'
      )}
      onClick={onClick}
      data-testid={`research-note-card-${note._id}`}
    >
      <div className="flex items-start gap-1.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            {note.isPinned && (
              <Pin className="size-3 text-primary flex-shrink-0" data-testid="pin-icon" />
            )}
            <span className="font-medium truncate">{note.title}</span>
          </div>
          <div className="flex items-center gap-1 mt-1">
            <Badge variant="secondary" className="text-xs px-1 py-0">
              {CATEGORY_LABELS[note.category] || note.category}
            </Badge>
            {note.tags.slice(0, 2).map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs px-1 py-0">
                {tag}
              </Badge>
            ))}
            {note.tags.length > 2 && (
              <span className="text-xs text-muted-foreground">
                +{note.tags.length - 2}
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}
