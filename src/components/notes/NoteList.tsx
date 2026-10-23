'use client';

import React from 'react';
import { StateNotice } from '@/components/kit/StateNotice';
import { Button } from '@/components/ui/button';
import { useResearchNotes } from '@/hooks/useResearchNotes';
import { cn } from '@/lib/utils';
import type { ResearchNote } from '@/types/research-note';

export interface NoteListProps {
  notes?: ResearchNote[];
  isLoading?: boolean;
  isError?: boolean;
  selectedId?: string | null;
  onSelectNote: (note: ResearchNote) => void;
  onNewNote?: () => void;
  className?: string;
}

function formatDate(dateStr?: string | null): string {
  if (!dateStr) return 'n/a';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'n/a';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getFirstLine(content?: string): string {
  if (!content) return '';
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return '';
}

export const NoteList: React.FC<NoteListProps> = ({
  notes,
  isLoading,
  isError,
  selectedId,
  onSelectNote,
  onNewNote,
  className,
}) => {
  const hookResult = useResearchNotes();

  const resolvedNotes = notes !== undefined ? notes : hookResult.data?.notes ?? [];
  const resolvedLoading = isLoading !== undefined ? isLoading : hookResult.isLoading;
  const resolvedError = isError !== undefined ? isError : hookResult.isError;

  if (resolvedLoading) {
    return (
      <StateNotice
        kind="loading"
        title="Loading notes..."
        className={className}
      />
    );
  }

  if (resolvedError) {
    return (
      <StateNotice
        kind="error"
        title="Failed to load notes."
        description="Please check your connection and try again."
        className={className}
      />
    );
  }

  if (resolvedNotes.length === 0) {
    return (
      <StateNotice
        kind="empty"
        title="No notes yet. Write your first note."
        action={
          onNewNote ? (
            <Button
              type="button"
              onClick={onNewNote}
              className="rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold min-h-[44px] px-5"
            >
              New note
            </Button>
          ) : undefined
        }
        className={className}
      />
    );
  }

  return (
    <div
      role="list"
      aria-label="Notes list"
      className={cn('space-y-2.5', className)}
    >
      {resolvedNotes.map((note) => {
        const isSelected = selectedId === note._id;
        const firstLine = getFirstLine(note.content);

        return (
          <div
            key={note._id}
            role="button"
            tabIndex={0}
            aria-pressed={isSelected}
            aria-label={`Open note: ${note.title}`}
            onClick={() => onSelectNote(note)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelectNote(note);
              }
            }}
            className={cn(
              'group w-full text-left p-4 rounded-[14px] border transition-colors cursor-pointer min-h-[44px] focus-visible:outline-3 focus-visible:outline-ring flex flex-col gap-1.5',
              isSelected
                ? 'border-foreground bg-muted/40 shadow-xs'
                : 'border-edge/30 bg-card hover:bg-muted/20'
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-semibold text-foreground text-[15px] leading-snug line-clamp-1 group-hover:text-foreground">
                {note.title}
              </h3>
              <span className="px-2 py-0.5 rounded-[6px] text-[12px] font-semibold bg-muted/30 text-ink-2 shrink-0">
                {note.category}
              </span>
            </div>

            {firstLine && (
              <p className="text-[13px] text-muted-foreground line-clamp-1 leading-normal">
                {firstLine}
              </p>
            )}

            <span className="text-[12px] text-muted-foreground font-sans tabular-nums mt-0.5">
              Updated {formatDate(note.updatedAt || note.createdAt)}
            </span>
          </div>
        );
      })}
    </div>
  );
};
