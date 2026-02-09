'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { BacktestConfig } from '@/lib/backtest/types';

interface BacktestConfigPanelProps {
  config: BacktestConfig;
  onChange: (config: BacktestConfig) => void;
}

export function BacktestConfigPanel({ config, onChange }: BacktestConfigPanelProps) {
  const update = <K extends keyof BacktestConfig>(key: K, value: BacktestConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  return (
    <Card data-testid="backtest-config-panel">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Configuration</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="entry-threshold" className="text-xs">
            Entry Threshold (long)
          </Label>
          <Input
            id="entry-threshold"
            type="number"
            value={config.entryThreshold}
            onChange={(e) => update('entryThreshold', Number(e.target.value))}
            className="h-8 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="exit-threshold" className="text-xs">
            Exit Threshold (long)
          </Label>
          <Input
            id="exit-threshold"
            type="number"
            value={config.exitThreshold}
            onChange={(e) => update('exitThreshold', Number(e.target.value))}
            className="h-8 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="stop-loss" className="text-xs">
            Stop Loss %
          </Label>
          <Input
            id="stop-loss"
            type="number"
            step="0.01"
            value={config.stopLossPercent * 100}
            onChange={(e) => update('stopLossPercent', Number(e.target.value) / 100)}
            className="h-8 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="take-profit" className="text-xs">
            Take Profit %
          </Label>
          <Input
            id="take-profit"
            type="number"
            step="0.01"
            value={config.takeProfitPercent * 100}
            onChange={(e) => update('takeProfitPercent', Number(e.target.value) / 100)}
            className="h-8 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="position-size" className="text-xs">
            Position Size %
          </Label>
          <Input
            id="position-size"
            type="number"
            step="1"
            value={config.positionSizePercent * 100}
            onChange={(e) => update('positionSizePercent', Number(e.target.value) / 100)}
            className="h-8 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="fee-percent" className="text-xs">
            Fee %
          </Label>
          <Input
            id="fee-percent"
            type="number"
            step="0.01"
            value={config.feePercent * 100}
            onChange={(e) => update('feePercent', Number(e.target.value) / 100)}
            className="h-8 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="start-equity" className="text-xs">
            Starting Capital
          </Label>
          <Input
            id="start-equity"
            type="number"
            value={config.startEquity}
            onChange={(e) => update('startEquity', Number(e.target.value))}
            className="h-8 text-sm"
          />
        </div>

        <div className="flex items-end space-x-2 pb-1">
          <input
            id="allow-shorts"
            type="checkbox"
            checked={config.allowShorts}
            onChange={(e) => update('allowShorts', e.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          <Label htmlFor="allow-shorts" className="text-xs">
            Allow Short Trades
          </Label>
        </div>
      </CardContent>
    </Card>
  );
}
