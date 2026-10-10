'use client';

import { useCallback, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useUIStore } from '@/stores/uiStore';
import { useProvisionalSignal } from '@/hooks/useProvisionalSignal';
import { isTrackRecordEligible, useTrackRecordBars } from '@/hooks/useTrackRecord';
import type { TradingStyle } from '@/lib/models/signal-template';
import { isProvisionalEligible } from '@/lib/signals/provisional/styles';
import { viewTally } from '@/lib/signals/track-record/chart-data';
import { TradingChart, type TimeRange } from './TradingChart';
import { SignalScoreStrip, resolveStyle } from './SignalScoreStrip';
import type { RecordedScore, RescoredScore } from './signal-score-indicator';
import { TrackRecordPanel } from './track-record/TrackRecordPanel';

/** A range reported for one symbol and interval; ignored once either changes. */
interface KeyedRange {
  key: string;
  range: TimeRange;
}

export function DashboardChart() {
  const { selectedSymbol, selectedInterval, setSelectedInterval, chartType, setChartType } =
    useUIStore(
      useShallow((s) => ({
        selectedSymbol: s.selectedSymbol,
        selectedInterval: s.selectedInterval,
        setSelectedInterval: s.setSelectedInterval,
        chartType: s.chartType,
        setChartType: s.setChartType,
      }))
    );
  const [dailyStyle, setDailyStyle] = useState<TradingStyle | null>(null);
  const style = resolveStyle(selectedInterval, dailyStyle);
  const signal = useProvisionalSignal(selectedSymbol, selectedInterval, style);

  const rangeKey = `${selectedSymbol}|${selectedInterval}`;
  const [loaded, setLoaded] = useState<KeyedRange | null>(null);
  const [visible, setVisible] = useState<KeyedRange | null>(null);
  const loadedRange = loaded?.key === rangeKey ? loaded.range : null;
  const visibleRange = visible?.key === rangeKey ? visible.range : null;
  const handleLoadedRange = useCallback((range: TimeRange) => setLoaded({ key: rangeKey, range }), [rangeKey]);
  const handleVisibleRange = useCallback((range: TimeRange) => setVisible({ key: rangeKey, range }), [rangeKey]);

  const trackEligible = isTrackRecordEligible(selectedSymbol, selectedInterval, style);
  const track = useTrackRecordBars(selectedSymbol, selectedInterval, style, loadedRange);

  // Live bars read from SignalOutcome fill the recorded series beyond the
  // GlobalSignal window; a GlobalSignal row wins (it carries data coverage).
  const { recordedScores, rescoredScores } = useMemo(() => {
    const recorded = new Map<number, RecordedScore>();
    const rescored = new Map<number, RescoredScore>();
    for (const bar of track.bars.values()) {
      if (bar.source === 'live' && track.configVersion !== null) {
        recorded.set(bar.t, { score: bar.score, tier: bar.tier, configVersion: track.configVersion });
      } else if (bar.source === 'rescore') {
        rescored.set(bar.t, { score: bar.score, tier: bar.tier });
      }
    }
    for (const [t, rec] of signal.recorded) recorded.set(t, rec);
    return { recordedScores: recorded, rescoredScores: rescored };
  }, [track.bars, track.configVersion, signal.recorded]);

  const inView = useMemo(
    () => (trackEligible && visibleRange ? viewTally(track.calls, visibleRange.from, visibleRange.to) : null),
    [trackEligible, visibleRange, track.calls]
  );

  const overlayVisible =
    isProvisionalEligible(selectedSymbol, selectedInterval, style) && signal.status !== 'unavailable';
  const overlayState =
    signal.status === 'provisional' || signal.status === 'awaiting-record' ? signal.status : null;

  return (
    <div>
      <div className="h-[500px]">
        <TradingChart
          symbol={selectedSymbol}
          interval={selectedInterval}
          chartType={chartType}
          onIntervalChange={setSelectedInterval}
          onChartTypeChange={setChartType}
          signalOverlay={{
            visible: overlayVisible,
            recorded: recordedScores,
            provisional: signal.provisional,
            state: overlayState,
            rescored: rescoredScores,
          }}
          callsOverlay={{
            visible: trackEligible,
            calls: track.calls,
            boundary: track.boundary,
            horizonBars: track.horizonBars,
            costPercent: track.costPercent,
          }}
          onLoadedRangeChange={handleLoadedRange}
          onVisibleRangeChange={handleVisibleRange}
        />
      </div>
      <SignalScoreStrip
        symbol={selectedSymbol}
        interval={selectedInterval}
        style={style}
        signal={signal}
        onStyleChange={setDailyStyle}
      />
      <TrackRecordPanel
        symbol={selectedSymbol}
        interval={selectedInterval}
        style={style}
        eligible={trackEligible}
        barsLoading={track.loading}
        barsError={track.error}
        inView={inView}
      />
    </div>
  );
}
