'use client';

import { useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

const PRESET_TAGS = [
  'breakout',
  'reversal',
  'trend-follow',
  'range-play',
  'overtrading',
  'revenge-trade',
  'scalp',
  'swing',
] as const;

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  maxTags?: number;
}

export function TagInput({ value, onChange, maxTags = 20 }: TagInputProps) {
  const [input, setInput] = useState('');

  function addTag(tag: string) {
    const normalized = tag.trim().toLowerCase();
    if (!normalized || value.includes(normalized) || value.length >= maxTags) return;
    onChange([...value, normalized]);
  }

  function removeTag(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(input);
      setInput('');
    } else if (e.key === 'Backspace' && !input && value.length > 0) {
      removeTag(value[value.length - 1]);
    }
  }

  const availablePresets = PRESET_TAGS.filter((t) => !value.includes(t));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {value.map((tag) => (
          <Badge key={tag} variant="secondary" className="text-xs gap-1 pr-1">
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="ml-0.5 hover:text-destructive"
              aria-label={`Remove tag ${tag}`}
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
      </div>

      <Input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a tag and press Enter"
        className="h-7 text-xs"
        data-testid="tag-input"
      />

      {availablePresets.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {availablePresets.map((preset) => (
            <Button
              key={preset}
              type="button"
              variant="ghost"
              size="sm"
              className="h-5 text-xs px-1.5 text-muted-foreground"
              onClick={() => addTag(preset)}
            >
              +{preset}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
