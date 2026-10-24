'use client';

import React, { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  useCreateResearchNote,
  useUpdateResearchNote,
} from '@/hooks/useResearchNotes';
import { cn } from '@/lib/utils';
import {
  RESEARCH_NOTE_CATEGORIES,
  type CreateResearchNoteInput,
  type ResearchNote,
  type ResearchNoteCategory,
  type UpdateResearchNoteInput,
} from '@/types/research-note';

export interface NoteEditorProps {
  note?: ResearchNote | null;
  onSuccess?: (savedNote?: ResearchNote) => void;
  onCancel?: () => void;
  className?: string;
}

export const NoteEditor: React.FC<NoteEditorProps> = ({
  note,
  onSuccess,
  onCancel,
  className,
}) => {
  const isEditing = !!note;
  const createMutation = useCreateResearchNote();
  const updateMutation = useUpdateResearchNote();

  const [title, setTitle] = useState(note?.title ?? '');
  const [category, setCategory] = useState<string>(note?.category ?? '');
  const [body, setBody] = useState(note?.content ?? '');

  const [errors, setErrors] = useState<{ title?: string; category?: string }>({});
  const [serverError, setServerError] = useState<string | null>(null);

  const isSubmitting = createMutation.isPending || updateMutation.isPending;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    const newErrors: { title?: string; category?: string } = {};
    const trimmedTitle = title.trim();

    if (!trimmedTitle) {
      newErrors.title = 'Title is required';
    } else if (trimmedTitle.length > 200) {
      newErrors.title = 'Title must be 200 characters or less';
    }

    if (!category) {
      newErrors.category = 'Category is required';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setErrors({});

    try {
      if (isEditing && note) {
        const updatePayload: UpdateResearchNoteInput = {
          title: trimmedTitle,
          category: category as ResearchNoteCategory,
          content: body,
        };

        const res = (await updateMutation.mutateAsync({
          id: note._id,
          ...updatePayload,
        })) as { note?: ResearchNote } | undefined;

        toast.success('Note saved');
        onSuccess?.(res?.note);
      } else {
        const createPayload: CreateResearchNoteInput = {
          title: trimmedTitle,
          category: category as ResearchNoteCategory,
          ...(body ? { content: body } : {}),
        };

        const res = (await createMutation.mutateAsync(createPayload)) as
          | { note?: ResearchNote }
          | undefined;
        toast.success('Note saved');
        onSuccess?.(res?.note);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save note';
      setServerError(msg);
    }
  };

  return (
    <form
      data-testid="note-editor"
      onSubmit={handleSubmit}
      className={cn(
        'rounded-panel bg-card p-5 sm:p-6 border border-edge/30 space-y-5',
        className
      )}
    >
      <div className="flex items-center justify-between gap-3 pb-3 border-b border-line">
        <h2 className="text-[18px] font-semibold text-foreground">
          {isEditing ? 'Edit note' : 'New note'}
        </h2>
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCancel}
            className="rounded-[12px] min-h-[44px] px-4 font-semibold text-[14px]"
          >
            Cancel
          </Button>
        )}
      </div>

      {serverError && (
        <div
          role="alert"
          className="p-3 rounded-[8px] bg-destructive/10 text-destructive text-[14px] font-medium"
        >
          {serverError}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="note-title"
          className="text-[13px] font-medium text-foreground"
        >
          Title
        </label>
        <input
          id="note-title"
          type="text"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (errors.title) setErrors((prev) => ({ ...prev, title: undefined }));
          }}
          aria-invalid={!!errors.title}
          aria-describedby={errors.title ? 'note-title-error' : undefined}
          placeholder="Note title"
          className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
        />
        {errors.title && (
          <p
            id="note-title-error"
            role="alert"
            className="text-[13px] text-destructive font-medium mt-0.5"
          >
            {errors.title}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="note-category"
          className="text-[13px] font-medium text-foreground"
        >
          Category
        </label>
        <select
          id="note-category"
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            if (errors.category) setErrors((prev) => ({ ...prev, category: undefined }));
          }}
          aria-invalid={!!errors.category}
          aria-describedby={errors.category ? 'note-category-error' : undefined}
          className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] cursor-pointer focus-visible:outline-3 focus-visible:outline-ring"
        >
          <option value="">Select a category</option>
          {RESEARCH_NOTE_CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {cat.charAt(0).toUpperCase() + cat.slice(1)}
            </option>
          ))}
        </select>
        {errors.category && (
          <p
            id="note-category-error"
            role="alert"
            className="text-[13px] text-destructive font-medium mt-0.5"
          >
            {errors.category}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="note-body"
          className="text-[13px] font-medium text-foreground"
        >
          Body
        </label>
        <textarea
          id="note-body"
          rows={10}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write note content in markdown..."
          className="min-h-[140px] px-3 py-2.5 rounded-[12px] border border-edge bg-card text-foreground text-[14px] leading-relaxed focus-visible:outline-3 focus-visible:outline-ring resize-y"
        />
      </div>

      <div className="flex justify-end gap-3 pt-2">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            className="rounded-[12px] min-h-[44px] px-4 font-semibold text-[14px]"
          >
            Cancel
          </Button>
        )}
        <Button
          type="submit"
          disabled={isSubmitting}
          className="rounded-[12px] min-h-[44px] px-5 font-semibold text-[14px] bg-brand text-brand-foreground hover:bg-brand/90"
        >
          {isSubmitting ? 'Saving note...' : 'Save note'}
        </Button>
      </div>
    </form>
  );
};
