import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TagInput } from './TagInput';

describe('TagInput', () => {
  it('renders existing tags', () => {
    render(<TagInput value={['breakout', 'reversal']} onChange={vi.fn()} />);
    expect(screen.getByText('breakout')).toBeInTheDocument();
    expect(screen.getByText('reversal')).toBeInTheDocument();
  });

  it('adds tag on Enter', () => {
    const onChange = vi.fn();
    render(<TagInput value={[]} onChange={onChange} />);
    const input = screen.getByTestId('tag-input');
    fireEvent.change(input, { target: { value: 'newtag' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['newtag']);
  });

  it('adds tag on comma', () => {
    const onChange = vi.fn();
    render(<TagInput value={[]} onChange={onChange} />);
    const input = screen.getByTestId('tag-input');
    fireEvent.change(input, { target: { value: 'newtag' } });
    fireEvent.keyDown(input, { key: ',' });
    expect(onChange).toHaveBeenCalledWith(['newtag']);
  });

  it('removes tag on X click', () => {
    const onChange = vi.fn();
    render(<TagInput value={['breakout', 'reversal']} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Remove tag breakout'));
    expect(onChange).toHaveBeenCalledWith(['reversal']);
  });

  it('removes last tag on Backspace with empty input', () => {
    const onChange = vi.fn();
    render(<TagInput value={['breakout', 'reversal']} onChange={onChange} />);
    const input = screen.getByTestId('tag-input');
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledWith(['breakout']);
  });

  it('does not add duplicate tags', () => {
    const onChange = vi.fn();
    render(<TagInput value={['breakout']} onChange={onChange} />);
    const input = screen.getByTestId('tag-input');
    fireEvent.change(input, { target: { value: 'breakout' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not add empty tags', () => {
    const onChange = vi.fn();
    render(<TagInput value={[]} onChange={onChange} />);
    const input = screen.getByTestId('tag-input');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows preset tag buttons', () => {
    render(<TagInput value={[]} onChange={vi.fn()} />);
    expect(screen.getByText('+breakout')).toBeInTheDocument();
    expect(screen.getByText('+reversal')).toBeInTheDocument();
  });

  it('hides preset buttons for already-selected tags', () => {
    render(<TagInput value={['breakout']} onChange={vi.fn()} />);
    expect(screen.queryByText('+breakout')).not.toBeInTheDocument();
    expect(screen.getByText('+reversal')).toBeInTheDocument();
  });

  it('adds preset tag on click', () => {
    const onChange = vi.fn();
    render(<TagInput value={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText('+reversal'));
    expect(onChange).toHaveBeenCalledWith(['reversal']);
  });

  it('normalizes tags to lowercase', () => {
    const onChange = vi.fn();
    render(<TagInput value={[]} onChange={onChange} />);
    const input = screen.getByTestId('tag-input');
    fireEvent.change(input, { target: { value: 'MyTag' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['mytag']);
  });
});
