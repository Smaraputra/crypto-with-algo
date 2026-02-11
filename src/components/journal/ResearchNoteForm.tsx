'use client';

import { useState } from 'react';
import { Plus, Eye, PenLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TagInput } from './TagInput';
import { MarkdownPreview } from './MarkdownPreview';
import { useCreateResearchNote, useUpdateResearchNote } from '@/hooks/useResearchNotes';
import { RESEARCH_NOTE_CATEGORIES } from '@/types/research-note';
import type { ResearchNote } from '@/types/research-note';

const CATEGORY_LABELS: Record<string, string> = {
  strategy: 'Strategy',
  concept: 'Concept',
  rule: 'Rule',
  checklist: 'Checklist',
  observation: 'Observation',
};

interface ResearchNoteFormProps {
  note?: ResearchNote;
  trigger?: React.ReactNode;
  onClose?: () => void;
}

export function ResearchNoteForm({ note, trigger, onClose }: ResearchNoteFormProps) {
  const isEdit = !!note;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(note?.title ?? '');
  const [content, setContent] = useState(note?.content ?? '');
  const [category, setCategory] = useState(note?.category ?? '');
  const [tags, setTags] = useState<string[]>(note?.tags ?? []);
  const [relatedSymbols, setRelatedSymbols] = useState(
    note?.relatedSymbols?.join(', ') ?? ''
  );
  const [previewMode, setPreviewMode] = useState(false);

  const createNote = useCreateResearchNote();
  const updateNote = useUpdateResearchNote();
  const isPending = createNote.isPending || updateNote.isPending;

  function handleSubmit() {
    const symbols = relatedSymbols
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    if (isEdit) {
      updateNote.mutate(
        {
          id: note._id,
          title,
          content,
          category: category as (typeof RESEARCH_NOTE_CATEGORIES)[number],
          tags: tags.length > 0 ? tags : undefined,
          relatedSymbols: symbols.length > 0 ? symbols : undefined,
        },
        {
          onSuccess: () => {
            setOpen(false);
            onClose?.();
          },
        }
      );
    } else {
      if (!category) return;
      createNote.mutate(
        {
          title,
          content: content || undefined,
          category: category as (typeof RESEARCH_NOTE_CATEGORIES)[number],
          tags: tags.length > 0 ? tags : undefined,
          relatedSymbols: symbols.length > 0 ? symbols : undefined,
        },
        {
          onSuccess: () => {
            setOpen(false);
            resetForm();
          },
        }
      );
    }
  }

  function resetForm() {
    setTitle('');
    setContent('');
    setCategory('');
    setTags([]);
    setRelatedSymbols('');
    setPreviewMode(false);
  }

  const defaultTrigger = (
    <Button size="sm" variant="outline" className="text-xs">
      <Plus className="mr-1 size-3.5" />
      New Note
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger ?? defaultTrigger}</DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Note' : 'New Research Note'}</DialogTitle>
          <DialogDescription>
            {isEdit ? 'Update your research note.' : 'Add a note to your trading playbook.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Note title"
              className="h-7 text-xs"
              maxLength={200}
              data-testid="note-title-input"
            />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="h-7 text-xs" data-testid="note-category-select">
                <SelectValue placeholder="Select category..." />
              </SelectTrigger>
              <SelectContent>
                {RESEARCH_NOTE_CATEGORIES.map((cat) => (
                  <SelectItem key={cat} value={cat} className="text-xs">
                    {CATEGORY_LABELS[cat]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Tags</Label>
            <TagInput value={tags} onChange={setTags} />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Related Symbols</Label>
            <Input
              value={relatedSymbols}
              onChange={(e) => setRelatedSymbols(e.target.value)}
              placeholder="BTCUSDT, ETHUSDT"
              className="h-7 text-xs font-mono"
              data-testid="note-symbols-input"
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label className="text-xs">Content (markdown)</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-5 text-[10px] px-1.5"
                onClick={() => setPreviewMode(!previewMode)}
              >
                {previewMode ? (
                  <>
                    <PenLine className="mr-0.5 size-3" />
                    Edit
                  </>
                ) : (
                  <>
                    <Eye className="mr-0.5 size-3" />
                    Preview
                  </>
                )}
              </Button>
            </div>
            {previewMode ? (
              <div className="min-h-[120px] border rounded-md p-2 bg-muted/30">
                <MarkdownPreview content={content} />
              </div>
            ) : (
              <Textarea
                value={content}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  setContent(e.target.value)
                }
                placeholder="Write your research notes in markdown..."
                className="text-xs min-h-[120px]"
                maxLength={50000}
                data-testid="note-content-input"
              />
            )}
          </div>

          <Button
            size="sm"
            className="w-full"
            onClick={handleSubmit}
            disabled={isPending || !title || !category}
          >
            {isPending ? 'Saving...' : isEdit ? 'Update Note' : 'Create Note'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
