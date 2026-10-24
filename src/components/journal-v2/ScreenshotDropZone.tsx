'use client';

import React, { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  MAX_SCREENSHOT_BYTES,
  SCREENSHOT_TYPES,
  type ScreenshotType,
} from '@/types/journal';

export interface ScreenshotDropZoneProps {
  /** Valid files, already filtered. */
  onFiles: (files: File[]) => void;
  /** How many more the entry can take. */
  remaining: number;
  disabled?: boolean;
}

export function pickImageFiles(
  list: FileList | File[],
  remaining: number
): { files: File[]; errors: string[] } {
  const items = Array.from(list);
  const errors: string[] = [];
  const validFiles: File[] = [];

  for (const file of items) {
    if (!SCREENSHOT_TYPES.includes(file.type as ScreenshotType)) {
      errors.push(`${file.name} is not PNG, JPEG or WebP.`);
      continue;
    }
    if (file.size > MAX_SCREENSHOT_BYTES) {
      errors.push(`${file.name} is over 5 MB.`);
      continue;
    }
    validFiles.push(file);
  }

  const effectiveRemaining = Math.max(0, remaining);
  if (validFiles.length > effectiveRemaining) {
    errors.push('An entry holds at most 4 screenshots.');
    return {
      files: validFiles.slice(0, effectiveRemaining),
      errors,
    };
  }

  return {
    files: validFiles,
    errors,
  };
}

export const ScreenshotDropZone: React.FC<ScreenshotDropZoneProps> = ({
  onFiles,
  remaining,
  disabled = false,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileList = (list: FileList | File[]) => {
    if (disabled || remaining <= 0) return;
    const result = pickImageFiles(list, remaining);
    setErrors(result.errors);
    if (result.files.length > 0) {
      onFiles(result.files);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled || remaining <= 0) return;
    if (e.dataTransfer?.files?.length) {
      handleFileList(e.dataTransfer.files);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (disabled || remaining <= 0) return;
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    if (disabled || remaining <= 0) return;
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      handleFileList(files);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFileList(e.target.files);
    }
    e.target.value = '';
  };

  if (remaining <= 0) {
    return (
      <div className="border border-dashed border-edge rounded-[12px] p-4 text-center">
        <p className="text-[13px] text-muted-foreground">
          This entry has 4 screenshots, the most it can hold.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div
        tabIndex={0}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onPaste={handlePaste}
        className={cn(
          'border border-dashed rounded-[12px] p-4 flex flex-col items-center justify-center text-center gap-2.5 transition-colors focus-visible:outline-3 focus-visible:outline-ring',
          isDragging ? 'border-foreground bg-muted/20' : 'border-edge'
        )}
      >
        <input
          ref={fileInputRef}
          id="screenshot-files-input"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          disabled={disabled}
          onChange={handleInputChange}
          className="sr-only"
        />
        <label htmlFor="screenshot-files-input" className="sr-only">
          Screenshot files
        </label>

        <p className="text-[13px] text-muted-foreground">
          Paste, drop or choose up to {remaining} more images. PNG, JPEG or WebP, 5 MB each.
        </p>

        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          className="rounded-[12px] min-h-[44px] px-4 text-[13px] font-medium"
        >
          Choose images
        </Button>
      </div>

      {errors.length > 0 && (
        <div role="alert" className="space-y-1 text-[13px] text-down">
          {errors.map((err) => (
            <p key={err}>{err}</p>
          ))}
        </div>
      )}
    </div>
  );
};
