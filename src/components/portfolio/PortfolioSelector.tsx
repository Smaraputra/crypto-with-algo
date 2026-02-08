'use client';

import { useState } from 'react';
import { ChevronDown, Plus, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  usePortfolios,
  useCreatePortfolio,
  useRenamePortfolio,
  useDeletePortfolio,
} from '@/hooks/usePortfolio';

interface PortfolioSelectorProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function PortfolioSelector({ selectedId, onSelect }: PortfolioSelectorProps) {
  const { data, isLoading } = usePortfolios();
  const createPortfolio = useCreatePortfolio();
  const renamePortfolio = useRenamePortfolio();
  const deletePortfolio = useDeletePortfolio();

  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const portfolios = data?.portfolios ?? [];
  const selected = portfolios.find((p) => p._id === selectedId);

  const handleCreate = () => {
    if (!newName.trim()) return;
    createPortfolio.mutate(newName.trim(), {
      onSuccess: () => {
        setNewName('');
        setIsCreating(false);
      },
    });
  };

  const handleRename = (id: string) => {
    if (!editName.trim()) return;
    renamePortfolio.mutate(
      { id, name: editName.trim() },
      {
        onSuccess: () => {
          setEditingId(null);
          setEditName('');
        },
      }
    );
  };

  const handleDelete = (id: string) => {
    deletePortfolio.mutate(id, {
      onSuccess: () => {
        if (selectedId === id && portfolios.length > 1) {
          const remaining = portfolios.find((p) => p._id !== id);
          if (remaining) onSelect(remaining._id);
        }
      },
    });
  };

  if (isLoading) {
    return (
      <div className="h-9 w-48 animate-shimmer rounded-sm" data-testid="selector-skeleton" />
    );
  }

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="gap-1" data-testid="portfolio-selector-trigger">
            {selected?.name ?? 'Select Portfolio'}
            <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {portfolios.map((p) => (
            <DropdownMenuItem
              key={p._id}
              className="flex items-center justify-between"
              onSelect={(e) => {
                if (editingId === p._id) {
                  e.preventDefault();
                  return;
                }
                onSelect(p._id);
              }}
            >
              {editingId === p._id ? (
                <form
                  className="flex flex-1 items-center gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleRename(p._id);
                  }}
                >
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="flex-1 rounded border border-border bg-background px-1 text-sm"
                    autoFocus
                    aria-label="Rename portfolio"
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setEditingId(null);
                      }
                    }}
                  />
                </form>
              ) : (
                <>
                  <span className={p._id === selectedId ? 'font-semibold' : ''}>
                    {p.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {p.holdingsCount} holdings
                  </span>
                </>
              )}
              {editingId !== p._id && (
                <span className="ml-1 flex gap-0.5">
                  <button
                    type="button"
                    className="rounded p-0.5 hover:bg-muted"
                    aria-label={`Rename ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(p._id);
                      setEditName(p.name);
                    }}
                  >
                    <Pencil className="size-3" />
                  </button>
                  <button
                    type="button"
                    className="rounded p-0.5 hover:bg-destructive/10"
                    aria-label={`Delete ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(p._id);
                    }}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </span>
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          {isCreating ? (
            <div className="px-2 py-1.5">
              <form
                className="flex items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleCreate();
                }}
              >
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Portfolio name"
                  className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm"
                  autoFocus
                  aria-label="New portfolio name"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setIsCreating(false);
                      setNewName('');
                    }
                  }}
                />
                <Button type="submit" size="sm" variant="outline" disabled={!newName.trim()}>
                  Add
                </Button>
              </form>
            </div>
          ) : (
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                setIsCreating(true);
              }}
            >
              <Plus className="mr-2 size-4" />
              Create New Portfolio
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
