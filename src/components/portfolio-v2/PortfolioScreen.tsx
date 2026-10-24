'use client';

import React, { useMemo, useState } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { PageHeader } from '@/components/kit/PageHeader';
import { SegmentedControl } from '@/components/kit/SegmentedControl';
import { StateNotice } from '@/components/kit/StateNotice';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { PortfolioSummary } from './PortfolioSummary';
import { HoldingsTable } from './HoldingsTable';
import { PerformanceView } from './PerformanceView';
import {
  usePortfolios,
  usePortfolio,
  useCreatePortfolio,
  useRenamePortfolio,
  useDeletePortfolio,
} from '@/hooks/usePortfolio';

export const PortfolioScreen: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Active tab state from URL search params
  const tabParam = searchParams.get('tab');
  const activeTab = tabParam === 'performance' ? 'performance' : 'holdings';

  const handleTabChange = (val: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (val === 'performance') {
      params.set('tab', 'performance');
    } else {
      params.delete('tab');
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  };

  // Portfolios list
  const { data: portfoliosData, isLoading: isPortfoliosLoading } = usePortfolios();
  const portfolios = useMemo(() => portfoliosData?.portfolios || [], [portfoliosData]);

  const [userSelectedId, setUserSelectedId] = useState<string | null>(null);

  const selectedPortfolioId = useMemo(() => {
    if (portfolios.length === 0) return null;
    if (userSelectedId && portfolios.some((p) => p._id === userSelectedId)) {
      return userSelectedId;
    }
    return portfolios[0]._id;
  }, [portfolios, userSelectedId]);

  // Active portfolio detail
  const { data: portfolioDetailData } = usePortfolio(selectedPortfolioId);
  const currentPortfolio = portfolioDetailData?.portfolio;

  // Mutations
  const createPortfolioMutation = useCreatePortfolio();
  const renamePortfolioMutation = useRenamePortfolio();
  const deletePortfolioMutation = useDeletePortfolio();

  // Dialog states
  const [createOpen, setCreateOpen] = useState(false);
  const [newPortfolioName, setNewPortfolioName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const [renameOpen, setRenameOpen] = useState(false);
  const [renamePortfolioName, setRenamePortfolioName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);

  const [deleteOpen, setDeleteOpen] = useState(false);

  // Handle open rename dialog
  const handleOpenRename = () => {
    const active = portfolios.find((p) => p._id === selectedPortfolioId);
    setRenamePortfolioName(active?.name || '');
    setRenameError(null);
    setRenameOpen(true);
  };

  // Handle submit create
  const handleCreatePortfolio = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPortfolioName.trim()) {
      setCreateError('Please enter a portfolio name.');
      return;
    }
    try {
      const created = (await createPortfolioMutation.mutateAsync(newPortfolioName.trim())) as {
        portfolio?: { _id?: string };
      };
      // Switch to the portfolio just created, rather than leaving the previous one selected.
      if (created?.portfolio?._id) setUserSelectedId(String(created.portfolio._id));
      setNewPortfolioName('');
      setCreateOpen(false);
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create portfolio');
    }
  };

  // Handle submit rename
  const handleRenamePortfolio = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedPortfolioId) return;
    if (!renamePortfolioName.trim()) {
      setRenameError('Please enter a new name.');
      return;
    }
    try {
      await renamePortfolioMutation.mutateAsync({
        id: selectedPortfolioId,
        name: renamePortfolioName.trim(),
      });
      setRenameOpen(false);
    } catch (err: unknown) {
      setRenameError(err instanceof Error ? err.message : 'Failed to rename portfolio');
    }
  };

  // Handle confirm delete
  const handleDeletePortfolio = async () => {
    if (!selectedPortfolioId) return;
    try {
      await deletePortfolioMutation.mutateAsync(selectedPortfolioId);
      setDeleteOpen(false);
    } catch {
      // toast is triggered by hook onError
    }
  };

  const activePortfolio = portfolios.find((p) => p._id === selectedPortfolioId);

  return (
    <div className="space-y-4">
      {/* Page Header */}
      <PageHeader
        title="Portfolio"
        actions={
          portfolios.length > 0 ? (
            <div className="flex items-center gap-2 flex-wrap">
              <label
                htmlFor="portfolio-select"
                className="sr-only"
              >
                Portfolio
              </label>
              <select
                id="portfolio-select"
                aria-label="Portfolio"
                value={selectedPortfolioId || ''}
                onChange={(e) => setUserSelectedId(e.target.value)}
                className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground font-semibold text-[14px] focus-visible:outline-3 focus-visible:outline-ring cursor-pointer"
              >
                {portfolios.map((p) => (
                  <option key={p._id} value={p._id}>
                    {p.name}
                  </option>
                ))}
              </select>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    className="min-h-[44px] rounded-[12px] border-edge px-3 text-[14px] font-semibold"
                  >
                    Manage
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onClick={handleOpenRename}>
                    Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-down focus:text-down"
                    onClick={() => setDeleteOpen(true)}
                  >
                    Delete
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      setNewPortfolioName('');
                      setCreateError(null);
                      setCreateOpen(true);
                    }}
                  >
                    New portfolio
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : undefined
        }
      />

      {/* Loading state */}
      {isPortfoliosLoading && (
        <StateNotice kind="loading" title="Loading portfolios..." />
      )}

      {/* Empty state: when user has no portfolio */}
      {!isPortfoliosLoading && portfolios.length === 0 && (
        <StateNotice
          kind="empty"
          title="Create your first portfolio to track holdings."
          action={
            <Button
              onClick={() => {
                setNewPortfolioName('');
                setCreateError(null);
                setCreateOpen(true);
              }}
              className="rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold min-h-[44px] px-5"
            >
              New portfolio
            </Button>
          }
        />
      )}

      {/* Content when portfolios exist */}
      {!isPortfoliosLoading && portfolios.length > 0 && selectedPortfolioId && (
        <div className="space-y-6">
          {/* View Tab Switcher */}
          <div className="flex items-center justify-between">
            <SegmentedControl
              legend="View"
              value={activeTab}
              onChange={handleTabChange}
              options={[
                { value: 'holdings', label: 'Holdings' },
                { value: 'performance', label: 'Performance' },
              ]}
            />
          </div>

          {activeTab === 'performance' ? (
            <PerformanceView portfolioId={selectedPortfolioId} />
          ) : (
            <div className="space-y-6">
              <PortfolioSummary
                holdings={currentPortfolio?.holdings || []}
              />
              <HoldingsTable
                portfolioId={selectedPortfolioId}
                holdings={currentPortfolio?.holdings || []}
              />
            </div>
          )}
        </div>
      )}

      {/* Create Portfolio Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New portfolio</DialogTitle>
            <DialogDescription>
              Create a new portfolio to track holdings.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreatePortfolio} className="space-y-4 mt-2">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="new-portfolio-name"
                className="text-[14px] font-medium text-foreground"
              >
                Portfolio name
              </label>
              <input
                id="new-portfolio-name"
                type="text"
                placeholder="e.g. Long term cold storage"
                value={newPortfolioName}
                onChange={(e) => {
                  setNewPortfolioName(e.target.value);
                  if (createError) setCreateError(null);
                }}
                className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
              />
              {createError && (
                <p role="alert" className="text-[13px] text-down">
                  {createError}
                </p>
              )}
            </div>
            <DialogFooter className="flex flex-row justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
                className="rounded-[12px] min-h-[44px] px-4"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createPortfolioMutation.isPending}
                className="rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold min-h-[44px] px-5"
              >
                {createPortfolioMutation.isPending ? 'Creating...' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rename Portfolio Dialog */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Rename portfolio</DialogTitle>
            <DialogDescription>
              Change the name of your portfolio.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleRenamePortfolio} className="space-y-4 mt-2">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="rename-portfolio-name"
                className="text-[14px] font-medium text-foreground"
              >
                Portfolio name
              </label>
              <input
                id="rename-portfolio-name"
                type="text"
                value={renamePortfolioName}
                onChange={(e) => {
                  setRenamePortfolioName(e.target.value);
                  if (renameError) setRenameError(null);
                }}
                className="min-h-[44px] px-3 py-2 rounded-[12px] border border-edge bg-card text-foreground text-[14px] focus-visible:outline-3 focus-visible:outline-ring"
              />
              {renameError && (
                <p role="alert" className="text-[13px] text-down">
                  {renameError}
                </p>
              )}
            </div>
            <DialogFooter className="flex flex-row justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenameOpen(false)}
                className="rounded-[12px] min-h-[44px] px-4"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={renamePortfolioMutation.isPending}
                className="rounded-full bg-brand text-brand-foreground hover:bg-brand/90 font-semibold min-h-[44px] px-5"
              >
                {renamePortfolioMutation.isPending ? 'Renaming...' : 'Rename'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete portfolio</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{activePortfolio?.name}&quot;?
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-row justify-end gap-3 mt-4">
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              className="rounded-[12px] min-h-[44px] px-4"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deletePortfolioMutation.isPending}
              onClick={handleDeletePortfolio}
              className="rounded-[12px] min-h-[44px] px-4"
            >
              {deletePortfolioMutation.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
