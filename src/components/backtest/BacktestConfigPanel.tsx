'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MARKET_SESSIONS, SESSION_LABELS, type MarketSession } from '@/lib/sessions';
import type { BacktestConfig } from '@/lib/backtest/types';

interface BacktestConfigPanelProps {
  config: BacktestConfig;
  onChange: (config: BacktestConfig) => void;
}

interface Preset {
  label: string;
  description: string;
  values: Partial<BacktestConfig>;
}

// Score levels scaled by 0.8, the ratio of the calibrated buy cutoff (24) to the
// previous one (30), so each preset keeps its relative selectivity. At the old
// levels the Conservative preset (40) almost never entered a trade.
const PRESETS: Preset[] = [
  {
    label: 'Conservative',
    description: 'Tight stops, small position',
    values: {
      stopLossPercent: 0.03,
      takeProfitPercent: 0.06,
      positionSizePercent: 0.05,
      allowShorts: false,
      entryThreshold: 32,
      exitThreshold: -4,
    },
  },
  {
    label: 'Balanced',
    description: 'Default parameters',
    values: {
      stopLossPercent: 0.05,
      takeProfitPercent: 0.10,
      positionSizePercent: 0.10,
      allowShorts: false,
      entryThreshold: 24,
      exitThreshold: -8,
    },
  },
  {
    label: 'Aggressive',
    description: 'Wider stops, larger position, shorts',
    values: {
      stopLossPercent: 0.08,
      takeProfitPercent: 0.15,
      positionSizePercent: 0.20,
      allowShorts: true,
      entryThreshold: 16,
      exitThreshold: -12,
      shortEntryThreshold: -16,
      shortExitThreshold: 12,
    },
  },
];

export function BacktestConfigPanel({ config, onChange }: BacktestConfigPanelProps) {
  const update = <K extends keyof BacktestConfig>(key: K, value: BacktestConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  function applyPreset(preset: Preset) {
    onChange({ ...config, ...preset.values });
  }

  // Undefined/empty allowedSessions means every session is allowed
  const sessionActive = (session: MarketSession) =>
    !config.allowedSessions ||
    config.allowedSessions.length === 0 ||
    config.allowedSessions.includes(session);

  function toggleSession(session: MarketSession) {
    const current =
      !config.allowedSessions || config.allowedSessions.length === 0
        ? [...MARKET_SESSIONS]
        : config.allowedSessions;
    const next = current.includes(session)
      ? current.filter((s) => s !== session)
      : [...current, session];
    // All sessions selected collapses back to "no filter"
    update('allowedSessions', next.length === MARKET_SESSIONS.length ? undefined : next);
  }

  return (
    <Card data-testid="backtest-config-panel">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">Configuration</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Presets */}
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Presets</Label>
          <div className="flex gap-2" data-testid="config-presets">
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                type="button"
                size="xs"
                variant="outline"
                onClick={() => applyPreset(preset)}
                title={preset.description}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>

        {/* Signal Thresholds */}
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground" data-testid="group-signal-thresholds">
            Signal Thresholds
          </h4>
          <div className="grid gap-3 sm:grid-cols-2">
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
            {config.allowShorts && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="short-entry-threshold" className="text-xs">
                    Entry Threshold (short)
                  </Label>
                  <Input
                    id="short-entry-threshold"
                    type="number"
                    value={config.shortEntryThreshold}
                    onChange={(e) => update('shortEntryThreshold', Number(e.target.value))}
                    className="h-8 text-sm"
                    data-testid="short-entry-threshold"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="short-exit-threshold" className="text-xs">
                    Exit Threshold (short)
                  </Label>
                  <Input
                    id="short-exit-threshold"
                    type="number"
                    value={config.shortExitThreshold}
                    onChange={(e) => update('shortExitThreshold', Number(e.target.value))}
                    className="h-8 text-sm"
                    data-testid="short-exit-threshold"
                  />
                </div>
              </>
            )}
          </div>
        </div>

        {/* Risk Management */}
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground" data-testid="group-risk-management">
            Risk Management
          </h4>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
          </div>
        </div>

        {/* Entry Sessions */}
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground" data-testid="group-sessions">
            Entry Sessions (UTC, intraday intervals only)
          </h4>
          <div className="flex flex-wrap gap-2" data-testid="session-toggles">
            {MARKET_SESSIONS.map((session) => (
              <Button
                key={session}
                type="button"
                size="xs"
                variant={sessionActive(session) ? 'secondary' : 'outline'}
                onClick={() => toggleSession(session)}
                data-testid={`session-toggle-${session}`}
                aria-pressed={sessionActive(session)}
              >
                {SESSION_LABELS[session]}
              </Button>
            ))}
          </div>
        </div>

        {/* Capital */}
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground" data-testid="group-capital">
            Capital
          </h4>
          <div className="grid gap-3 sm:grid-cols-2">
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
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
