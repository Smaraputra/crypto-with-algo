'use client';

import { useState } from 'react';
import { Settings, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { INDICATOR_PARAMS, getDefaultCalcParams } from './indicator-params';

interface IndicatorSettingsProps {
  indicatorId: string;
  indicatorName: string;
  calcParams: number[];
  onParamsChange: (indicatorId: string, params: number[]) => void;
}

export function IndicatorSettings({
  indicatorId,
  indicatorName,
  calcParams,
  onParamsChange,
}: IndicatorSettingsProps) {
  const paramDefs = INDICATOR_PARAMS[indicatorId];
  const [open, setOpen] = useState(false);

  if (!paramDefs || paramDefs.length === 0) return null;

  function handleSliderChange(index: number, value: number[]) {
    const newParams = [...calcParams];
    newParams[index] = value[0];
    onParamsChange(indicatorId, newParams);
  }

  function handleInputChange(index: number, value: string) {
    const num = parseInt(value, 10);
    if (isNaN(num)) return;
    const def = paramDefs[index];
    const clamped = Math.max(def.min, Math.min(def.max, num));
    const newParams = [...calcParams];
    newParams[index] = clamped;
    onParamsChange(indicatorId, newParams);
  }

  function handleReset() {
    onParamsChange(indicatorId, getDefaultCalcParams(indicatorId));
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          aria-label={`Settings for ${indicatorName}`}
        >
          <Settings className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64" align="start">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{indicatorName}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-xs"
              onClick={handleReset}
              aria-label={`Reset ${indicatorName} parameters`}
            >
              <RotateCcw className="h-3 w-3" />
              Reset
            </Button>
          </div>
          {paramDefs.map((def, index) => (
            <div key={def.label} className="space-y-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs">{def.label}</Label>
                <Input
                  type="number"
                  value={calcParams[index] ?? def.defaultValue}
                  onChange={(e) => handleInputChange(index, e.target.value)}
                  className="h-6 w-16 text-right text-xs"
                  min={def.min}
                  max={def.max}
                  step={def.step}
                />
              </div>
              <Slider
                value={[calcParams[index] ?? def.defaultValue]}
                onValueChange={(value) => handleSliderChange(index, value)}
                min={def.min}
                max={def.max}
                step={def.step}
                className="py-1"
              />
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
