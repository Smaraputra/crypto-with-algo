'use client';

import { useId, useState, type ReactNode } from 'react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Small form pieces for the Cost Check page. Numbers are typed as text and
 * committed only when they parse inside their bounds, so a half-typed "0."
 * never turns into a zero and the last valid value keeps driving the result.
 */

interface NumberFieldProps {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  unit?: string;
  hint?: ReactNode;
  min: number;
  max: number;
  /** Whether an empty field is a valid "not set" (null). */
  optional?: boolean;
  placeholder?: string;
  integer?: boolean;
  className?: string;
}

function format(value: number | null): string {
  return value === null ? '' : String(value);
}

export function NumberField({
  label,
  value,
  onChange,
  unit,
  hint,
  min,
  max,
  optional = false,
  placeholder,
  integer = false,
  className,
}: NumberFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const [text, setText] = useState(format(value));
  const [lastValue, setLastValue] = useState(value);
  // A value set from outside (a preset, a URL) replaces what is typed.
  if (value !== lastValue) {
    setLastValue(value);
    if (Number(text) !== value || (value === null && text !== '')) setText(format(value));
  }

  const parsed = text.trim() === '' ? null : Number(text);
  const valid =
    parsed === null
      ? optional
      : Number.isFinite(parsed) && parsed >= min && parsed <= max && (!integer || Number.isInteger(parsed));

  function handle(next: string) {
    setText(next);
    const n = next.trim() === '' ? null : Number(next);
    const ok = n === null ? optional : Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n));
    if (ok) {
      setLastValue(n);
      onChange(n);
    }
  }

  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      <label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </label>
      <div className="relative">
        <Input
          id={id}
          inputMode={integer ? 'numeric' : 'decimal'}
          autoComplete="off"
          value={text}
          placeholder={placeholder}
          aria-invalid={!valid}
          aria-describedby={hint || unit ? hintId : undefined}
          onChange={(e) => handle(e.target.value)}
          className={cn('font-mono tabular-nums', unit && 'pr-14')}
        />
        {unit && (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
            {unit}
          </span>
        )}
      </div>
      {(hint || unit) && (
        <p id={hintId} className={cn('text-xs text-muted-foreground', !hint && 'sr-only')}>
          {hint ?? `in ${unit}`}
        </p>
      )}
      {!valid && (
        <p className="text-xs text-bearish" role="alert">
          Enter {integer ? 'a whole number' : 'a number'} from {min} to {max.toLocaleString('en-US')}
          {optional ? ', or leave it empty' : ''}.
        </p>
      )}
    </div>
  );
}

interface SegmentedProps<T extends string> {
  legend: string;
  name: string;
  value: T | null;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}

/** A radio group drawn as a row of buttons: native radios, so arrow keys and screen readers work. */
export function Segmented<T extends string>({ legend, name, value, options, onChange, className }: SegmentedProps<T>) {
  return (
    <fieldset className={cn('min-w-0 space-y-1', className)}>
      <legend className="mb-1 text-xs text-muted-foreground">{legend}</legend>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              className={cn(
                'relative inline-flex min-h-7 cursor-pointer items-center rounded-sm border px-2.5 text-xs transition-colors',
                'has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
                checked
                  ? 'border-border-strong bg-card-hover text-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground'
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
                // Covers the whole label, so the native radio is the full-size pointer target.
                className="absolute inset-0 m-0 cursor-pointer appearance-none opacity-0"
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
