import React, { useId } from 'react';
import { cn } from '@/lib/utils';

export interface SegmentedControlOption {
  value: string;
  label: string;
}

export interface SegmentedControlProps {
  options: SegmentedControlOption[];
  value: string;
  onChange: (value: string) => void;
  legend: string;
  name?: string;
  className?: string;
}

export const SegmentedControl: React.FC<SegmentedControlProps> = ({
  options,
  value,
  onChange,
  legend,
  name,
  className,
}) => {
  const generatedId = useId();
  const groupName = name ?? `segmented-${generatedId}`;

  return (
    <fieldset
      className={cn(
        'inline-flex items-center border border-edge rounded-[12px] p-[3px] gap-[2px] bg-card relative',
        className
      )}
    >
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => {
        const inputId = `${groupName}-${option.value}`;
        const isChecked = option.value === value;

        return (
          <React.Fragment key={option.value}>
            <input
              type="radio"
              id={inputId}
              name={groupName}
              value={option.value}
              checked={isChecked}
              onChange={() => onChange(option.value)}
              className="sr-only peer"
            />
            <label
              htmlFor={inputId}
              className={cn(
                'min-w-[48px] min-h-[44px] px-3 inline-flex items-center justify-center rounded-[9px] font-semibold text-[14px] cursor-pointer relative select-none transition-colors duration-120 active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100',
                'peer-focus-visible:outline-3 peer-focus-visible:outline-ring peer-focus-visible:outline-offset-[3px] peer-focus-visible:outline',
                isChecked
                  ? 'bg-brand text-brand-foreground'
                  : 'text-ink-2 hover:bg-muted hover:text-foreground'
              )}
            >
              {option.label}
            </label>
          </React.Fragment>
        );
      })}
    </fieldset>
  );
};
