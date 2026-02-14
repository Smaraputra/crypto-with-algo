'use client';

import { useState } from 'react';
import { Search, Pin, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { MarkdownPreview } from './MarkdownPreview';
import { ResearchNoteCard } from './ResearchNoteCard';
import { ResearchNoteForm } from './ResearchNoteForm';
import {
  useResearchNotes,
  useUpdateResearchNote,
  useDeleteResearchNote,
} from '@/hooks/useResearchNotes';
import { RESEARCH_NOTE_CATEGORIES } from '@/types/research-note';
import type { ResearchNote } from '@/types/research-note';

const CATEGORY_LABELS: Record<string, string> = {
  strategy: 'Strategy',
  concept: 'Concept',
  rule: 'Rule',
  checklist: 'Checklist',
  observation: 'Observation',
};

export function PlaybookView() {
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

  const { data, isLoading } = useResearchNotes({
    category: categoryFilter || undefined,
    search: search || undefined,
    limit: 50,
    sort: '-isPinned,-createdAt',
  });

  const updateNote = useUpdateResearchNote();
  const deleteNote = useDeleteResearchNote();

  const notes = data?.notes ?? [];
  const selectedNote = notes.find((n: ResearchNote) => n._id === selectedNoteId) ?? null;

  function handleTogglePin(note: ResearchNote) {
    updateNote.mutate({ id: note._id, isPinned: !note.isPinned });
  }

  function handleDelete(note: ResearchNote) {
    deleteNote.mutate(note._id);
    if (selectedNoteId === note._id) {
      setSelectedNoteId(null);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-3" data-testid="playbook-loading">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-4" data-testid="playbook-view">
      {/* Left sidebar: note list */}
      <div className="w-72 flex-shrink-0 space-y-2">
        <div className="flex items-center gap-1">
          <ResearchNoteForm />
        </div>

        <div className="relative">
          <Search className="absolute left-2 top-1.5 size-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search notes..."
            className="h-8 pl-7 text-xs"
            data-testid="playbook-search"
          />
        </div>

        <div className="flex flex-wrap gap-1">
          <Button
            variant={categoryFilter === '' ? 'default' : 'outline'}
            size="xs"
            onClick={() => setCategoryFilter('')}
          >
            All
          </Button>
          {RESEARCH_NOTE_CATEGORIES.map((cat) => (
            <Button
              key={cat}
              variant={categoryFilter === cat ? 'default' : 'outline'}
              size="xs"
              onClick={() => setCategoryFilter(cat)}
            >
              {CATEGORY_LABELS[cat]}
            </Button>
          ))}
        </div>

        {notes.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4" data-testid="playbook-empty">
            No notes found.
          </p>
        ) : (
          <div className="space-y-1 max-h-[60vh] overflow-y-auto" data-testid="playbook-note-list">
            {notes.map((note: ResearchNote) => (
              <ResearchNoteCard
                key={note._id}
                note={note}
                isSelected={selectedNoteId === note._id}
                onClick={() => setSelectedNoteId(note._id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Right panel: note detail */}
      <div className="flex-1 min-w-0">
        {selectedNote ? (
          <Card data-testid="playbook-detail">
            <CardContent className="space-y-3">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-sm font-semibold">{selectedNote.title}</h3>
                <div className="flex items-center gap-1 mt-1">
                  <Badge variant="secondary" className="text-xs">
                    {CATEGORY_LABELS[selectedNote.category]}
                  </Badge>
                  {selectedNote.tags.map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
                {selectedNote.relatedSymbols.length > 0 && (
                  <div className="flex items-center gap-1 mt-1">
                    {selectedNote.relatedSymbols.map((sym) => (
                      <span key={sym} className="text-xs font-mono text-muted-foreground">
                        {sym}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => handleTogglePin(selectedNote)}
                  title={selectedNote.isPinned ? 'Unpin' : 'Pin'}
                >
                  <Pin className={`size-3.5 ${selectedNote.isPinned ? 'text-primary' : ''}`} />
                </Button>
                <ResearchNoteForm
                  note={selectedNote}
                  trigger={
                    <Button variant="ghost" size="xs">
                      Edit
                    </Button>
                  }
                />
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-destructive"
                  onClick={() => handleDelete(selectedNote)}
                  data-testid="delete-note-button"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>

            <div className="border-t border-border pt-3">
              <MarkdownPreview content={selectedNote.content} />
            </div>

            <div className="text-xs text-muted-foreground">
              Updated {new Date(selectedNote.updatedAt).toLocaleDateString()}
            </div>
            </CardContent>
          </Card>
        ) : (
          <div
            className="flex flex-col items-center justify-center h-full min-h-[200px] text-center"
            data-testid="playbook-no-selection"
          >
            <p className="text-sm text-muted-foreground">
              Select a note to view its contents.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
