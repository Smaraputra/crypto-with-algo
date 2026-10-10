import { CALL_COLORS } from '../signal-calls-indicator';

/** A triangle as the price pane draws it: up under a buy bar, down over a sell bar. */
export function Mark({ up, color, hollow = false }: { up: boolean; color: string; hollow?: boolean }) {
  const points = up ? '5,1 9,9 1,9' : '1,1 9,1 5,9';
  return (
    <svg viewBox="0 0 10 10" className="inline-block size-2.5 shrink-0" aria-hidden="true">
      <polygon points={points} fill={hollow ? 'none' : color} stroke={color} strokeWidth={hollow ? 1.2 : 0} />
    </svg>
  );
}

const OUTCOMES = [
  { key: 'won', label: 'won after costs', color: CALL_COLORS.won },
  { key: 'cost', label: 'right, but costs ate it', color: CALL_COLORS.cost },
  { key: 'wrong', label: 'wrong way', color: CALL_COLORS.wrong },
  { key: 'pending', label: 'outcome pending', color: CALL_COLORS.pending, hollow: true },
] as const;

/** Key to the marks the chart draws, in the words the tooltips use. */
export function CallLegend() {
  return (
    <div className="mt-3 space-y-1.5" data-testid="call-legend">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5">
          <Mark up color={CALL_COLORS.pending} /> buy call, under the bar
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Mark up={false} color={CALL_COLORS.pending} /> sell call, over the bar
        </span>
      </p>
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Call colours">
        {OUTCOMES.map((o) => (
          <li key={o.key} className="inline-flex items-center gap-1.5">
            <Mark up color={o.color} hollow={'hollow' in o && o.hollow} />
            {o.label}
          </li>
        ))}
      </ul>
      <p>
        Hover or touch a call to see its score, its outcome, and the line from its close to the close it was judged on. The
        dashed line splits re-scored calls (left) from the live record (right). In the score pane, darker bars are re-scored.
      </p>
    </div>
  );
}
