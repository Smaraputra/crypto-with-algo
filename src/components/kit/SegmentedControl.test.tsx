import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl';

describe('SegmentedControl', () => {
  const options = [
    { value: '1h', label: '1H' },
    { value: '4h', label: '4H' },
    { value: '1d', label: '1D' },
    { value: '1w', label: '1W' },
  ];

  it('one radio is checked per value', () => {
    render(
      <SegmentedControl
        options={options}
        value="1d"
        onChange={vi.fn()}
        legend="Chart interval"
      />
    );

    const checkedRadio = screen.getByRole('radio', { name: '1D' });
    expect(checkedRadio).toBeChecked();

    const uncheckedRadios = ['1H', '4H', '1W'].map((label) =>
      screen.getByRole('radio', { name: label })
    );
    for (const radio of uncheckedRadios) {
      expect(radio).not.toBeChecked();
    }
  });

  it('choosing another option calls onChange with its value', () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        options={options}
        value="1d"
        onChange={onChange}
        legend="Chart interval"
      />
    );

    const option4H = screen.getByLabelText('4H');
    fireEvent.click(option4H);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('4h');
  });

  it('the legend is present for screen readers', () => {
    render(
      <SegmentedControl
        options={options}
        value="1d"
        onChange={vi.fn()}
        legend="Chart interval"
      />
    );

    const group = screen.getByRole('group', { name: 'Chart interval' });
    expect(group).toBeInTheDocument();
  });

  it('applies ink fill to the selected option label', () => {
    render(
      <SegmentedControl
        options={options}
        value="1d"
        onChange={vi.fn()}
        legend="Chart interval"
      />
    );

    const selectedLabel = screen.getByText('1D');
    expect(selectedLabel).toHaveClass('bg-foreground', 'text-background');
    expect(selectedLabel).not.toHaveClass('bg-brand', 'text-brand-foreground');

    const unselectedLabel = screen.getByText('4H');
    expect(unselectedLabel).toHaveClass('text-ink-2');
    expect(unselectedLabel).not.toHaveClass('bg-foreground', 'text-background');
  });
});
