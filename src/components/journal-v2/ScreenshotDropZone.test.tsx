import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ScreenshotDropZone, pickImageFiles } from './ScreenshotDropZone';

describe('pickImageFiles', () => {
  it('filters out unsupported formats and oversized files', () => {
    const validPng = new File(['123'], 'chart.png', { type: 'image/png' });
    const invalidGif = new File(['123'], 'anim.gif', { type: 'image/gif' });
    const bigFile = new File(['a'.repeat(100)], 'huge.png', { type: 'image/png' });
    Object.defineProperty(bigFile, 'size', { value: 6 * 1024 * 1024 });

    const result = pickImageFiles([validPng, invalidGif, bigFile], 4);
    expect(result.files).toEqual([validPng]);
    expect(result.errors).toEqual([
      'anim.gif is not PNG, JPEG or WebP.',
      'huge.png is over 5 MB.',
    ]);
  });

  it('caps at remaining files and returns cap error', () => {
    const f1 = new File(['1'], 'shot1.png', { type: 'image/png' });
    const f2 = new File(['2'], 'shot2.png', { type: 'image/png' });
    const f3 = new File(['3'], 'shot3.png', { type: 'image/png' });

    const result = pickImageFiles([f1, f2, f3], 2);
    expect(result.files).toEqual([f1, f2]);
    expect(result.errors).toEqual(['An entry holds at most 4 screenshots.']);
  });
});

describe('ScreenshotDropZone component', () => {
  it('calls onFiles when valid files are chosen via input', () => {
    const onFiles = vi.fn();
    render(<ScreenshotDropZone onFiles={onFiles} remaining={3} />);

    const input = screen.getByLabelText('Screenshot files') as HTMLInputElement;
    const file = new File(['bytes'], 'shot.webp', { type: 'image/webp' });

    fireEvent.change(input, { target: { files: [file] } });

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it('shows error lines for GIF and 6 MB PNG', () => {
    const onFiles = vi.fn();
    render(<ScreenshotDropZone onFiles={onFiles} remaining={4} />);

    const input = screen.getByLabelText('Screenshot files') as HTMLInputElement;
    const gifFile = new File(['bytes'], 'chart.gif', { type: 'image/gif' });
    const bigFile = new File(['bytes'], 'huge.png', { type: 'image/png' });
    Object.defineProperty(bigFile, 'size', { value: 6 * 1024 * 1024 });

    fireEvent.change(input, { target: { files: [gifFile, bigFile] } });

    expect(screen.getByText('chart.gif is not PNG, JPEG or WebP.')).toBeInTheDocument();
    expect(screen.getByText('huge.png is over 5 MB.')).toBeInTheDocument();
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('excess beyond remaining gives the cap line and keeps remaining', () => {
    const onFiles = vi.fn();
    render(<ScreenshotDropZone onFiles={onFiles} remaining={1} />);

    const input = screen.getByLabelText('Screenshot files') as HTMLInputElement;
    const f1 = new File(['1'], 'shot1.png', { type: 'image/png' });
    const f2 = new File(['2'], 'shot2.png', { type: 'image/png' });

    fireEvent.change(input, { target: { files: [f1, f2] } });

    expect(screen.getByText('An entry holds at most 4 screenshots.')).toBeInTheDocument();
    expect(onFiles).toHaveBeenCalledWith([f1]);
  });

  it('handles paste with an image file', () => {
    const onFiles = vi.fn();
    const { container } = render(<ScreenshotDropZone onFiles={onFiles} remaining={3} />);

    const dropTarget = container.querySelector('[tabindex="0"]')!;
    const file = new File(['image-data'], 'pasted.png', { type: 'image/png' });

    fireEvent.paste(dropTarget, {
      clipboardData: {
        files: [file],
      },
    });

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  it('with remaining 0 renders the muted line and no choose button', () => {
    const onFiles = vi.fn();
    render(<ScreenshotDropZone onFiles={onFiles} remaining={0} />);

    expect(
      screen.getByText('This entry has 4 screenshots, the most it can hold.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choose images' })).not.toBeInTheDocument();
  });
});
