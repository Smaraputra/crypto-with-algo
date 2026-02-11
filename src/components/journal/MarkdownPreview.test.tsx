import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownPreview } from './MarkdownPreview';

describe('MarkdownPreview', () => {
  it('renders markdown content', () => {
    render(<MarkdownPreview content="**bold text**" />);
    expect(screen.getByText('bold text')).toBeInTheDocument();
  });

  it('renders empty state for blank content', () => {
    render(<MarkdownPreview content="" />);
    expect(screen.getByText('No content to preview')).toBeInTheDocument();
  });

  it('renders empty state for whitespace-only content', () => {
    render(<MarkdownPreview content="   " />);
    expect(screen.getByText('No content to preview')).toBeInTheDocument();
  });

  it('renders with testid', () => {
    render(<MarkdownPreview content="test" />);
    expect(screen.getByTestId('markdown-preview')).toBeInTheDocument();
  });

  it('renders links', () => {
    render(<MarkdownPreview content="[click here](https://example.com)" />);
    const link = screen.getByText('click here');
    expect(link).toBeInTheDocument();
    expect(link.closest('a')).toHaveAttribute('href', 'https://example.com');
  });

  it('renders code blocks', () => {
    render(<MarkdownPreview content={"`code`"} />);
    expect(screen.getByText('code')).toBeInTheDocument();
  });
});
