'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/kit/PageHeader';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useResearchNotes, type ResearchNoteFilters } from '@/hooks/useResearchNotes';
import {
  RESEARCH_NOTE_CATEGORIES,
  type ResearchNote,
} from '@/types/research-note';
import { cn } from '@/lib/utils';
import { NoteDetail } from './NoteDetail';
import { NoteEditor } from './NoteEditor';
import { NoteList } from './NoteList';

export interface NotesScreenProps {
  className?: string;
}

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => {
      if (typeof window !== 'undefined') {
        setIsMobile(window.innerWidth < 1024);
      }
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  return isMobile;
}

export const NotesScreen: React.FC<NotesScreenProps> = ({ className }) => {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isMobileSheetOpen, setIsMobileSheetOpen] = useState(false);

  const isMobile = useIsMobile();

  const filters = useMemo<ResearchNoteFilters>(() => {
    const f: ResearchNoteFilters = {};
    if (search.trim()) f.search = search.trim();
    if (category && category !== 'all') f.category = category;
    return f;
  }, [search, category]);

  const { data, isLoading, isError } = useResearchNotes(filters);
  const notes = useMemo(() => data?.notes ?? [], [data?.notes]);

  const selectedNote = useMemo(() => {
    if (!selectedNoteId) return null;
    return notes.find((n) => n._id === selectedNoteId) || null;
  }, [notes, selectedNoteId]);

  const handleSelectNote = (note: ResearchNote) => {
    setSelectedNoteId(note._id);
    setIsCreating(false);
    setIsEditing(false);
    setIsMobileSheetOpen(true);
  };

  const handleNewNote = () => {
    setIsCreating(true);
    setIsEditing(false);
    setSelectedNoteId(null);
    setIsMobileSheetOpen(true);
  };

  const handleSaved = (saved?: ResearchNote) => {
    setIsCreating(false);
    setIsEditing(false);
    setIsMobileSheetOpen(false);
    if (saved) {
      setSelectedNoteId(saved._id);
    }
  };

  return (
    <div className={cn('space-y-4', className)}>
      <PageHeader
        title="Notes"
        actions={
          <Button
            type="button"
            onClick={handleNewNote}
            className="rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold min-h-[44px] px-5"
          >
            New note
          </Button>
        }
      />

      {/* Switcher: Trades | Stats | Notes with Notes current */}
      <div className="flex items-center">
        <div className="inline-flex items-center border border-edge rounded-[12px] p-[3px] gap-[2px] bg-card">
          <Link
            href="/journal"
            // Inner radius: the 12px control less its 3px padding.
            className="min-w-[48px] min-h-[44px] px-3 inline-flex items-center justify-center rounded-[9px] font-semibold text-[14px] cursor-pointer select-none text-ink-2 hover:bg-muted hover:text-foreground transition-colors duration-120 active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[3px] focus-visible:outline"
          >
            Trades
          </Link>
          <Link
            href="/journal?view=stats"
            // Inner radius: the 12px control less its 3px padding.
            className="min-w-[48px] min-h-[44px] px-3 inline-flex items-center justify-center rounded-[9px] font-semibold text-[14px] cursor-pointer select-none text-ink-2 hover:bg-muted hover:text-foreground transition-colors duration-120 active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100 focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-[3px] focus-visible:outline"
          >
            Stats
          </Link>
          <span
            aria-current="page"
            // Inner radius: the 12px control less its 3px padding.
            className="min-w-[48px] min-h-[44px] px-3 inline-flex items-center justify-center rounded-[9px] font-semibold text-[14px] select-none bg-foreground text-background"
          >
            Notes
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left column: Filters and Note list */}
        <div className="lg:col-span-5 xl:col-span-4 space-y-4">
          <div className="p-4 rounded-[14px] bg-card border border-edge/30 space-y-4">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="notes-search-input"
                className="text-[13px] font-medium text-foreground"
              >
                Search notes
              </label>
              <input
                id="notes-search-input"
                type="search"
                aria-label="Search notes"
                placeholder="Search notes..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
              />
            </div>

            <div className="flex flex-col gap-1 min-w-[130px]">
              <label
                htmlFor="notes-filter-category"
                className="text-[13px] font-medium text-muted-foreground"
              >
                Category
              </label>
              <select
                id="notes-filter-category"
                aria-label="Category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] cursor-pointer focus-visible:outline-3 focus-visible:outline-ring"
              >
                <option value="all">All categories</option>
                {RESEARCH_NOTE_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat.charAt(0).toUpperCase() + cat.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <NoteList
            notes={notes}
            isLoading={isLoading}
            isError={isError}
            selectedId={selectedNote?._id ?? null}
            onSelectNote={handleSelectNote}
            onNewNote={handleNewNote}
          />
        </div>

        {/* Right column: Desktop Detail or Editor */}
        {!isMobile && (
          <div className="hidden lg:block lg:col-span-7 xl:col-span-8 sticky top-6">
            {isCreating ? (
              <NoteEditor
                onCancel={() => setIsCreating(false)}
                onSuccess={handleSaved}
              />
            ) : isEditing && selectedNote ? (
              <NoteEditor
                note={selectedNote}
                onCancel={() => setIsEditing(false)}
                onSuccess={handleSaved}
              />
            ) : selectedNote ? (
              <NoteDetail
                note={selectedNote}
                onEdit={() => setIsEditing(true)}
                onDelete={() => {
                  setSelectedNoteId(null);
                  setIsEditing(false);
                }}
              />
            ) : (
              <div className="rounded-panel bg-card p-10 border border-edge/30 text-center flex flex-col items-center justify-center min-h-[300px]">
                <p className="text-[15px] text-muted-foreground max-w-[32ch]">
                  Select a note to view details, or write a new note.
                </p>
                <Button
                  type="button"
                  onClick={handleNewNote}
                  className="mt-4 rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold min-h-[44px] px-5"
                >
                  New note
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Phone Sheet */}
      {isMobile && (
        <Sheet open={isMobileSheetOpen} onOpenChange={setIsMobileSheetOpen}>
          <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
            <SheetHeader className="sr-only">
              <SheetTitle>
                {isCreating ? 'New note' : selectedNote?.title ?? 'Note details'}
              </SheetTitle>
              <SheetDescription>Note details and editor</SheetDescription>
            </SheetHeader>
            <div className="pt-2">
              {isCreating ? (
                <NoteEditor
                  onCancel={() => setIsMobileSheetOpen(false)}
                  onSuccess={handleSaved}
                />
              ) : isEditing && selectedNote ? (
                <NoteEditor
                  note={selectedNote}
                  onCancel={() => setIsEditing(false)}
                  onSuccess={handleSaved}
                />
              ) : selectedNote ? (
                <NoteDetail
                  note={selectedNote}
                  onEdit={() => setIsEditing(true)}
                  onDelete={() => {
                    setSelectedNoteId(null);
                    setIsMobileSheetOpen(false);
                  }}
                />
              ) : null}
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
};
