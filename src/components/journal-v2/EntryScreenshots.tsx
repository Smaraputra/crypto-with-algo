'use client';

import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ScreenshotDropZone } from './ScreenshotDropZone';
import {
  useUploadJournalScreenshot,
  useDeleteJournalScreenshot,
} from '@/hooks/useJournal';
import type { JournalEntry } from '@/types/journal';

export interface EntryScreenshotsProps {
  entry: JournalEntry;
}

function getBaseAsset(sym: string): string {
  return sym.replace(/(USDT|USDC|BUSD)$/, '') || sym;
}

export const EntryScreenshots: React.FC<EntryScreenshotsProps> = ({ entry }) => {
  const screenshots = entry.screenshots ?? [];
  const baseAsset = getBaseAsset(entry.symbol);

  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const uploadMutation = useUploadJournalScreenshot();
  const deleteMutation = useDeleteJournalScreenshot();

  const activeScreenshot = activeIndex !== null ? screenshots[activeIndex] : null;

  const handleFiles = async (files: File[]) => {
    setUploadError(null);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setUploadStatus(`Uploading ${file.name} (${i + 1} of ${files.length})`);
      try {
        await uploadMutation.mutateAsync({ entryId: entry._id, file });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Upload failed';
        setUploadError(`${file.name} did not upload: ${msg}`);
        break;
      }
    }
    setUploadStatus(null);
  };

  const handleDelete = async () => {
    if (!activeScreenshot) return;
    try {
      await deleteMutation.mutateAsync({
        fileId: activeScreenshot.fileId,
        entryId: entry._id,
      });
      setConfirmingDelete(false);
      setActiveIndex(null);
    } catch {
      // delete mutation surfaces toast.error
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="text-[15px] font-semibold text-foreground">Screenshots</h3>

      {screenshots.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {screenshots.map((shot, index) => {
            const shotNumber = index + 1;
            return (
              <button
                type="button"
                key={shot.fileId}
                aria-label={`View screenshot ${shotNumber}`}
                onClick={() => {
                  setActiveIndex(index);
                  setConfirmingDelete(false);
                }}
                className="group relative aspect-[4/3] w-full overflow-hidden rounded-[8px] border border-edge/30 bg-muted/20 min-h-[44px] cursor-pointer focus-visible:outline-3 focus-visible:outline-ring"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- private screenshots (auth-only API or a local blob) must not pass through the public image optimizer */}
                <img
                  src={`/api/journal/screenshots/${shot.fileId}`}
                  alt={`Screenshot ${shotNumber} of the ${baseAsset} trade`}
                  loading="lazy"
                  className="size-full aspect-[4/3] object-cover rounded-[8px] transition-transform group-hover:scale-105"
                />
              </button>
            );
          })}
        </div>
      )}

      <ScreenshotDropZone
        remaining={Math.max(0, 4 - screenshots.length)}
        disabled={uploadMutation.isPending}
        onFiles={handleFiles}
      />

      {uploadStatus && (
        <p role="status" className="text-[13px] text-muted-foreground">
          {uploadStatus}
        </p>
      )}

      {uploadError && (
        <p role="alert" className="text-[13px] text-down">
          {uploadError}
        </p>
      )}

      <Dialog
        open={activeIndex !== null}
        onOpenChange={(open) => {
          if (!open) {
            setActiveIndex(null);
            setConfirmingDelete(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Screenshot {activeIndex !== null ? activeIndex + 1 : ''}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Screenshot full size preview
            </DialogDescription>
          </DialogHeader>

          {activeScreenshot && (
            <div className="flex flex-col items-center gap-4 py-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- private screenshots (auth-only API or a local blob) must not pass through the public image optimizer */}
              <img
                src={`/api/journal/screenshots/${activeScreenshot.fileId}`}
                alt={`Screenshot ${(activeIndex ?? 0) + 1} of the ${baseAsset} trade`}
                className="w-full max-h-[80vh] object-contain rounded-[8px]"
              />

              <div className="w-full flex items-center justify-end gap-3 pt-2">
                {confirmingDelete ? (
                  <div className="flex flex-col sm:flex-row items-center justify-between w-full gap-3 p-3 rounded-[12px] bg-muted/20 border border-edge/40">
                    <p className="text-[13px] text-muted-foreground">
                      Remove this screenshot? This cannot be undone.
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setConfirmingDelete(false)}
                        className="min-h-[44px] px-3 text-[13px] rounded-[12px]"
                      >
                        Keep
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={deleteMutation.isPending}
                        onClick={handleDelete}
                        className="min-h-[44px] px-3 text-[13px] rounded-[12px]"
                      >
                        {deleteMutation.isPending ? 'Removing...' : 'Remove'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => setConfirmingDelete(true)}
                    className="min-h-[44px] px-4 text-[13px] rounded-[12px]"
                  >
                    Remove screenshot
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};
