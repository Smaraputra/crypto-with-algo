'use client';

import React from 'react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
} from 'recharts';
import { Panel } from '@/components/kit/Panel';
import { StateNotice } from '@/components/kit/StateNotice';
import { useJournalAnalytics } from '@/hooks/useJournalAnalytics';
import { useChartTheme } from '@/lib/chart-theme';
import { SESSION_LABELS, type MarketSession } from '@/lib/sessions';
import {
  TRADE_EMOTION_LABELS,
  TRADE_MISTAKE_LABELS,
  type TradeEmotion,
  type TradeMistake,
} from '@/types/journal';
import { cn } from '@/lib/utils';

export interface StatsViewProps {
  className?: string;
}

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function formatPnl(pnl: number | null | undefined): { text: string; className: string } {
  if (pnl === null || pnl === undefined || !Number.isFinite(pnl)) {
    return { text: 'n/a', className: 'text-muted-foreground' };
  }
  if (pnl === 0) {
    return { text: '0.00%', className: 'text-foreground' };
  }
  const sign = pnl > 0 ? '+' : '';
  return {
    text: `${sign}${pnl.toFixed(2)}%`,
    className: pnl > 0 ? 'text-up font-medium' : 'text-down font-medium',
  };
}

function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) {
    return 'n/a';
  }
  return `${(rate * 100).toFixed(1)}%`;
}

export const StatsView: React.FC<StatsViewProps> = ({ className }) => {
  const chartTheme = useChartTheme();
  const { data, isLoading, isError } = useJournalAnalytics();

  if (isLoading) {
    return <StateNotice kind="loading" title="Loading stats..." className={className} />;
  }

  if (isError) {
    return (
      <StateNotice
        kind="error"
        title="Failed to load journal stats."
        description="Please check your connection and try again."
        className={className}
      />
    );
  }

  if (!data || data.summary.totalTrades === 0) {
    return (
      <StateNotice
        kind="empty"
        title="No stats available yet."
        description="Log and close trades to see performance statistics."
        className={className}
      />
    );
  }

  const {
    summary,
    byMonth = [],
    bySetupType = [],
    byTag = [],
    byEmotion = [],
    byMistake = [],
    bySession = [],
    byWeekday = [],
    streaks,
    kellySuggestion,
  } = data;

  // Kelly position-size suggestion was left out because sizing suggestions were removed from the product.
  const avgWin = kellySuggestion?.avgWinPercent;
  const avgLoss = kellySuggestion?.avgLossPercent;
  const avgWinLossDisplay =
    avgWin !== undefined && avgLoss !== undefined
      ? `+${avgWin.toFixed(2)}% / -${avgLoss.toFixed(2)}%`
      : 'n/a';

  const netPnl = formatPnl(summary.totalPnlPercent);

  const streakDisplay = streaks?.current
    ? `${streaks.current.length} ${streaks.current.type === 'win' ? 'wins' : 'losses'}`
    : 'None';

  return (
    <div className={cn('space-y-6', className)}>
      {/* Key totals once */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Panel className="p-4 sm:p-5 flex flex-col justify-between">
          <span className="text-[13px] font-medium text-muted-foreground">Total trades</span>
          <span className="text-[28px] font-semibold tracking-tight font-sans tabular-nums text-foreground mt-2">
            {summary.totalTrades}
          </span>
        </Panel>

        <Panel className="p-4 sm:p-5 flex flex-col justify-between">
          <span className="text-[13px] font-medium text-muted-foreground">Win rate</span>
          <span className="text-[28px] font-semibold tracking-tight font-sans tabular-nums text-foreground mt-2">
            {summary.winRate !== null ? `${(summary.winRate * 100).toFixed(1)}%` : 'n/a'}
          </span>
        </Panel>

        <Panel className="p-4 sm:p-5 flex flex-col justify-between">
          <span className="text-[13px] font-medium text-muted-foreground">Net P&L</span>
          <span
            className={cn(
              'text-[28px] font-semibold tracking-tight font-sans tabular-nums mt-2',
              netPnl.className
            )}
          >
            {netPnl.text}
          </span>
        </Panel>

        <Panel className="p-4 sm:p-5 flex flex-col justify-between">
          <span className="text-[13px] font-medium text-muted-foreground">Avg win vs avg loss</span>
          <span className="text-[20px] sm:text-[22px] font-semibold tracking-tight font-sans tabular-nums text-foreground mt-2">
            {avgWinLossDisplay}
          </span>
        </Panel>
      </div>

      {/* Streaks */}
      <Panel title="Streaks" level={3} className="p-4 sm:p-5">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-[14px]">
          <div>
            <span className="text-[13px] text-muted-foreground block">Current streak</span>
            <span className="text-[18px] font-semibold text-foreground mt-1 block">
              {streakDisplay}
            </span>
          </div>
          <div>
            <span className="text-[13px] text-muted-foreground block">Longest win streak</span>
            <span className="text-[18px] font-semibold font-sans tabular-nums text-up mt-1 block">
              {streaks?.maxWinStreak ?? 0} wins
            </span>
          </div>
          <div>
            <span className="text-[13px] text-muted-foreground block">Longest loss streak</span>
            <span className="text-[18px] font-semibold font-sans tabular-nums text-down mt-1 block">
              {streaks?.maxLossStreak ?? 0} losses
            </span>
          </div>
        </div>
      </Panel>

      {/* Monthly P&L chart with text alternative */}
      <Panel title="Monthly performance" level={3} className="p-4 sm:p-5">
        {byMonth.length === 0 ? (
          <p className="text-[14px] text-muted-foreground">No monthly data yet.</p>
        ) : (
          <div className="space-y-4">
            {/* Screen reader text alternative */}
            <div aria-label="Monthly performance text alternative" className="sr-only">
              <h4>Monthly performance text alternative</h4>
              <ul>
                {byMonth.map((m) => (
                  <li key={m.month}>
                    {m.month}: {m.pnlPercent >= 0 ? `+${m.pnlPercent.toFixed(2)}%` : `${m.pnlPercent.toFixed(2)}%`} ({m.tradeCount} trades)
                  </li>
                ))}
              </ul>
            </div>

            <div className="h-[240px] w-full" aria-hidden="true">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byMonth} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <XAxis
                    dataKey="month"
                    stroke={chartTheme.mutedText}
                    fontSize={12}
                    tickLine={false}
                    axisLine={{ stroke: chartTheme.line }}
                  />
                  <YAxis
                    stroke={chartTheme.mutedText}
                    fontSize={12}
                    tickLine={false}
                    axisLine={{ stroke: chartTheme.line }}
                    tickFormatter={(val) => `${val}%`}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'var(--card)',
                      borderColor: 'var(--edge)',
                      borderRadius: '8px',
                      fontSize: '13px',
                      color: 'var(--foreground)',
                    }}
                    formatter={(val: unknown) => [`${Number(val).toFixed(2)}%`, 'P&L']}
                  />
                  <Bar dataKey="pnlPercent" radius={[4, 4, 0, 0]}>
                    {byMonth.map((entry) => (
                      <Cell
                        key={entry.month}
                        fill={entry.pnlPercent >= 0 ? chartTheme.up : chartTheme.down}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </Panel>

      {/* Small tables: Setup, Tag, Emotion, Mistake, Session, Weekday */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Setup performance */}
        <Panel title="Performance by setup" level={3} className="p-4 sm:p-5">
          {bySetupType.length === 0 ? (
            <p className="text-[14px] text-muted-foreground">No setup data yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px] border-collapse">
                <thead>
                  <tr className="border-b border-line text-muted-foreground">
                    <th className="py-2 font-medium">Setup</th>
                    <th className="py-2 text-right font-medium">Trades</th>
                    <th className="py-2 text-right font-medium">Win rate</th>
                    <th className="py-2 text-right font-medium">Avg P&L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/40">
                  {bySetupType.map((s) => {
                    const avg = formatPnl(s.avgPnlPercent);
                    return (
                      <tr key={s.setupType} className="hover:bg-muted/20">
                        <td className="py-2 font-medium text-foreground">{s.setupType}</td>
                        <td className="py-2 text-right font-sans tabular-nums text-foreground">
                          {s.count}
                        </td>
                        <td className="py-2 text-right font-sans tabular-nums text-foreground">
                          {formatRate(s.winRate)}
                        </td>
                        <td className={cn('py-2 text-right font-sans tabular-nums', avg.className)}>
                          {avg.text}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Tag performance */}
        <Panel title="Performance by tag" level={3} className="p-4 sm:p-5">
          {byTag.length === 0 ? (
            <p className="text-[14px] text-muted-foreground">No tag data yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px] border-collapse">
                <thead>
                  <tr className="border-b border-line text-muted-foreground">
                    <th className="py-2 font-medium">Tag</th>
                    <th className="py-2 text-right font-medium">Trades</th>
                    <th className="py-2 text-right font-medium">Win rate</th>
                    <th className="py-2 text-right font-medium">Avg P&L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/40">
                  {byTag.map((t) => {
                    const avg = formatPnl(t.avgPnlPercent);
                    return (
                      <tr key={t.tag} className="hover:bg-muted/20">
                        <td className="py-2 font-medium text-foreground">{t.tag}</td>
                        <td className="py-2 text-right font-sans tabular-nums text-foreground">
                          {t.count}
                        </td>
                        <td className="py-2 text-right font-sans tabular-nums text-foreground">
                          {formatRate(t.winRate)}
                        </td>
                        <td className={cn('py-2 text-right font-sans tabular-nums', avg.className)}>
                          {avg.text}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Emotion performance */}
        <Panel title="Performance by emotion" level={3} className="p-4 sm:p-5">
          {byEmotion.length === 0 ? (
            <p className="text-[14px] text-muted-foreground">No emotion data yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px] border-collapse">
                <thead>
                  <tr className="border-b border-line text-muted-foreground">
                    <th className="py-2 font-medium">Emotion</th>
                    <th className="py-2 text-right font-medium">Trades</th>
                    <th className="py-2 text-right font-medium">Win rate</th>
                    <th className="py-2 text-right font-medium">Avg P&L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/40">
                  {byEmotion.map((e) => {
                    const avg = formatPnl(e.avgPnlPercent);
                    const label =
                      TRADE_EMOTION_LABELS[e.emotion as TradeEmotion] || e.emotion;
                    return (
                      <tr key={e.emotion} className="hover:bg-muted/20">
                        <td className="py-2 font-medium text-foreground">{label}</td>
                        <td className="py-2 text-right font-sans tabular-nums text-foreground">
                          {e.count}
                        </td>
                        <td className="py-2 text-right font-sans tabular-nums text-foreground">
                          {formatRate(e.winRate)}
                        </td>
                        <td className={cn('py-2 text-right font-sans tabular-nums', avg.className)}>
                          {avg.text}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Mistake performance */}
        <Panel title="Performance by mistake" level={3} className="p-4 sm:p-5">
          {byMistake.length === 0 ? (
            <p className="text-[14px] text-muted-foreground">No mistake data yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px] border-collapse">
                <thead>
                  <tr className="border-b border-line text-muted-foreground">
                    <th className="py-2 font-medium">Mistake</th>
                    <th className="py-2 text-right font-medium">Trades</th>
                    <th className="py-2 text-right font-medium">Avg P&L</th>
                    <th className="py-2 text-right font-medium">Total cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/40">
                  {byMistake.map((m) => {
                    const avg = formatPnl(m.avgPnlPercent);
                    const total = formatPnl(m.totalPnlPercent);
                    const label =
                      TRADE_MISTAKE_LABELS[m.mistake as TradeMistake] || m.mistake;
                    return (
                      <tr key={m.mistake} className="hover:bg-muted/20">
                        <td className="py-2 font-medium text-foreground">{label}</td>
                        <td className="py-2 text-right font-sans tabular-nums text-foreground">
                          {m.count}
                        </td>
                        <td className={cn('py-2 text-right font-sans tabular-nums', avg.className)}>
                          {avg.text}
                        </td>
                        <td className={cn('py-2 text-right font-sans tabular-nums', total.className)}>
                          {total.text}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Session performance */}
        <Panel title="Performance by session" level={3} className="p-4 sm:p-5">
          {bySession.length === 0 ? (
            <p className="text-[14px] text-muted-foreground">No session data yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px] border-collapse">
                <thead>
                  <tr className="border-b border-line text-muted-foreground">
                    <th className="py-2 font-medium">Session</th>
                    <th className="py-2 text-right font-medium">Trades</th>
                    <th className="py-2 text-right font-medium">Win rate</th>
                    <th className="py-2 text-right font-medium">Avg P&L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/40">
                  {bySession.map((s) => {
                    const avg = formatPnl(s.avgPnlPercent);
                    const label =
                      SESSION_LABELS[s.session as MarketSession] || s.session;
                    return (
                      <tr key={s.session} className="hover:bg-muted/20">
                        <td className="py-2 font-medium text-foreground">{label}</td>
                        <td className="py-2 text-right font-sans tabular-nums text-foreground">
                          {s.count}
                        </td>
                        <td className="py-2 text-right font-sans tabular-nums text-foreground">
                          {formatRate(s.winRate)}
                        </td>
                        <td className={cn('py-2 text-right font-sans tabular-nums', avg.className)}>
                          {avg.text}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {/* Weekday performance */}
        <Panel title="Performance by weekday" level={3} className="p-4 sm:p-5">
          {byWeekday.length === 0 ? (
            <p className="text-[14px] text-muted-foreground">No weekday data yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px] border-collapse">
                <thead>
                  <tr className="border-b border-line text-muted-foreground">
                    <th className="py-2 font-medium">Day</th>
                    <th className="py-2 text-right font-medium">Trades</th>
                    <th className="py-2 text-right font-medium">Win rate</th>
                    <th className="py-2 text-right font-medium">Avg P&L</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/40">
                  {byWeekday.map((w) => {
                    const avg = formatPnl(w.avgPnlPercent);
                    const dayName = WEEKDAY_NAMES[w.weekday] || `Day ${w.weekday}`;
                    return (
                      <tr key={w.weekday} className="hover:bg-muted/20">
                        <td className="py-2 font-medium text-foreground">{dayName}</td>
                        <td className="py-2 text-right font-sans tabular-nums text-foreground">
                          {w.count}
                        </td>
                        <td className="py-2 text-right font-sans tabular-nums text-foreground">
                          {formatRate(w.winRate)}
                        </td>
                        <td className={cn('py-2 text-right font-sans tabular-nums', avg.className)}>
                          {avg.text}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
};
