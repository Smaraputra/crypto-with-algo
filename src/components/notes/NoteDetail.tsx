'use client';

import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { useDeleteResearchNote } from '@/hooks/useResearchNotes';
import { cn } from '@/lib/utils';
import type { ResearchNote } from '@/types/research-note';

export interface NoteDetailProps {
  note: ResearchNote;
  onEdit?: () => void;
  onDelete?: (id: string) => void;
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

export const NoteDetail: React.FC<NoteDetailProps> = ({
  note,
  onEdit,
  onDelete,
  className,
}) => {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const deleteMutation = useDeleteResearchNote();

  const handleConfirmDelete = async () => {
    try {
      await deleteMutation.mutateAsync(note._id);
      setDeleteDialogOpen(false);
      onDelete?.(note._id);
    } catch {
      // Error toast is handled by useDeleteResearchNote onError
    }
  };

  return (
    <article
      data-testid="note-detail"
      className={cn(
        'rounded-panel bg-card p-5 sm:p-6 border border-edge/30 space-y-5',
        className
      )}
    >
      <header className="flex flex-col gap-3 pb-4 border-b border-line">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5 flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="px-2.5 py-0.5 rounded-[6px] text-[12px] font-semibold uppercase tracking-wider bg-muted/30 text-ink-2">
                {note.category}
              </span>
              <span className="text-[13px] text-muted-foreground">
                Updated {formatDate(note.updatedAt || note.createdAt)}
              </span>
            </div>
            <h2 className="text-[22px] font-semibold text-foreground leading-snug break-words">
              {note.title}
            </h2>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onEdit}
              className="rounded-[10px] min-h-[44px] px-4 font-semibold text-[14px]"
            >
              Edit
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => setDeleteDialogOpen(true)}
              className="rounded-[10px] min-h-[44px] px-4 font-semibold text-[14px]"
            >
              Delete
            </Button>
          </div>
        </div>
      </header>

      <div
        data-testid="note-body"
        className="prose prose-sm dark:prose-invert max-w-none text-foreground text-[15px] leading-relaxed break-words"
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {note.content || ''}
        </ReactMarkdown>
      </div>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete note</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this note? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-row justify-end gap-3 mt-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              className="rounded-[12px] min-h-[44px] px-4"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={handleConfirmDelete}
              className="rounded-[12px] min-h-[44px] px-4"
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  );
};
