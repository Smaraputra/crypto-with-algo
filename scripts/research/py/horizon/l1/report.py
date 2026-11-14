"""Simulation of the six trials, matched controls, aggregation and descriptive tables."""

from __future__ import annotations

import dataclasses
import datetime as dt
import math
from collections import defaultdict
from collections.abc import Sequence
from typing import Any

import numpy as np

from horizon.l1 import lock
from horizon.l1.controls import find_controls, liq_any_prefix, r_pre_series
from horizon.l1.data import Store
from horizon.l1.events import (
    eligible,
    find_bursts,
    find_candidates,
    select_events,
    span_end_dropped,
    spread_median,
    x_series,
)
from horizon.l1.fills import simulate_trade
from horizon.l1.stats import bootstrap_bound, describe, t_bound

__all__ = ["run_all", "simulate_account", "to_json_safe"]


def to_json_safe(obj: Any) -> Any:
    """Recursively convert objects to JSON-safe primitives, replacing NaN and inf with None."""
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return to_json_safe(dataclasses.asdict(obj))
    if isinstance(obj, dict):
        return {str(k): to_json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_json_safe(x) for x in obj]
    if isinstance(obj, np.ndarray):
        return to_json_safe(obj.tolist())
    if isinstance(obj, (np.floating, float)):
        val = float(obj)
        if math.isnan(val) or math.isinf(val):
            return None
        return val
    if isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    if isinstance(obj, (np.integer, int)):
        return int(obj)
    return obj


def get_symbol_class(symbol: str) -> str:
    """Classify symbol via lighter.lock.symbol_class or return 'unclassified'."""
    try:
        from lighter import lock as lighter_lock

        return lighter_lock.symbol_class(symbol)
    except Exception:
        return "unclassified"


def simulate_account(events: Sequence[dict], max_positions: int = 10, trade_usd: float = 10.0) -> dict:
    """Simulate account-following execution with a position cap."""
    if not events:
        return {
            "taken": 0,
            "skipped": 0,
            "mean_return": float("nan"),
            "total_usd_profit": 0.0,
        }

    sorted_events = sorted(
        events,
        key=lambda r: (r.get("d_index", 0), r.get("entry_ts", 0), r.get("market_id", 0)),
    )

    open_positions: list[int] = []
    taken = 0
    skipped = 0
    taken_rets: list[float] = []

    for ev in sorted_events:
        entry_ts = int(ev.get("entry_ts", -1))
        exit_ts = int(ev.get("exit_ts", -1))

        open_positions = [ts for ts in open_positions if ts > entry_ts]

        if len(open_positions) >= max_positions:
            skipped += 1
        else:
            taken += 1
            taken_rets.append(float(ev["ret"]))
            open_positions.append(exit_ts)

    mean_ret = float(np.mean(taken_rets)) if taken_rets else float("nan")
    total_profit = float(trade_usd * np.sum(taken_rets)) if taken_rets else 0.0

    return {
        "taken": taken,
        "skipped": skipped,
        "mean_return": mean_ret,
        "total_usd_profit": total_profit,
    }


def run_all(store: Store, market_ids: Sequence[int] | None = None) -> dict:
    """Run all six trials across markets, evaluate pass clauses, and compute descriptive tables."""
    if market_ids is None:
        market_ids = store.market_ids()

    side_bursts: dict[str, int] = {side: 0 for side in lock.SIDES}
    side_candidates: dict[str, int] = {side: 0 for side in lock.SIDES}
    side_events: dict[str, int] = {side: 0 for side in lock.SIDES}
    side_traded_events: dict[str, int] = {side: 0 for side in lock.SIDES}
    side_span_end: dict[str, int] = {side: 0 for side in lock.SIDES}
    side_inelig_activity: dict[str, int] = {side: 0 for side in lock.SIDES}
    side_inelig_no_sp: dict[str, int] = {side: 0 for side in lock.SIDES}
    side_eligible: dict[str, int] = {side: 0 for side in lock.SIDES}
    side_no_entry_fill: dict[str, int] = {side: 0 for side in lock.SIDES}

    trial_no_controls: dict[str, int] = {trial_id: 0 for trial_id in lock.TRIAL_IDS}
    profile_data: dict[str, dict[int, dict[int, list[float]]]] = {
        trial_id: {o: defaultdict(list) for o in lock.ENTRY_PROFILE_MIN} for trial_id in lock.TRIAL_IDS
    }

    all_rows: list[dict] = []

    for m_id in market_ids:
        md = store.market(m_id)
        xs, xs_valid = x_series(md)
        f_ts, f_rate = store.funding(m_id)
        liq_prefix = liq_any_prefix(md)
        r_pre = r_pre_series(md)
        sym_class = get_symbol_class(md.symbol)

        for side in lock.SIDES:
            bursts = find_bursts(md, side)
            candidates = find_candidates(md, side)
            side_bursts[side] += len(bursts)
            side_candidates[side] += len(candidates)
            events = select_events(candidates)
            side_events[side] += len(events)

            for e in events:
                e_ms = md.ms_of(e.e_index)
                if e_ms < lock.EVENTS_FROM_MS:
                    continue
                side_traded_events[side] += 1

                d_idx = e.d_index
                if span_end_dropped(d_idx, len(md.present)):
                    side_span_end[side] += 1
                    continue

                is_elig, reason = eligible(md, xs_valid, xs, d_idx)
                if not is_elig:
                    if reason == "activity":
                        side_inelig_activity[side] += 1
                    elif reason == "no_spread_proxy":
                        side_inelig_no_sp[side] += 1
                    continue

                side_eligible[side] += 1
                spm = spread_median(md, xs_valid, xs, d_idx)
                ctrl_xs = find_controls(md, xs, xs_valid, d_idx, e.i0, liq_prefix, r_pre)
                n_ctrls = len(ctrl_xs)

                d_ms = md.ms_of(d_idx)
                day_num = d_ms // lock.DAY_MS
                month_str = dt.datetime.fromtimestamp(d_ms / 1000, tz=dt.UTC).strftime("%Y-%m")

                for h in lock.EXIT_OFFSETS_MIN:
                    trial_id = f"{side}-{h}"
                    exit_idx = e.e_index + h
                    trade = simulate_trade(md, xs, spm, f_ts, f_rate, side, entry_index=d_idx, exit_index=exit_idx)

                    if trade.status == "no_entry_fill":
                        if h == lock.EXIT_OFFSETS_MIN[0]:
                            side_no_entry_fill[side] += 1
                        control_mean = float("nan")
                        excess = float("nan")
                    elif trade.status == "ok":
                        if n_ctrls < lock.CONTROLS_MIN:
                            trial_no_controls[trial_id] += 1
                            control_mean = float("nan")
                            excess = float("nan")
                        else:
                            ctrl_trades = [
                                simulate_trade(
                                    md,
                                    xs,
                                    spread_median(md, xs_valid, xs, cx),
                                    f_ts,
                                    f_rate,
                                    side,
                                    entry_index=cx,
                                    exit_index=cx + h - lock.ENTRY_OFFSET_MIN,
                                )
                                for cx in ctrl_xs
                            ]
                            if any(ct.status != "ok" for ct in ctrl_trades):
                                trial_no_controls[trial_id] += 1
                                control_mean = float("nan")
                                excess = float("nan")
                            else:
                                control_mean = float(np.mean([ct.ret for ct in ctrl_trades]))
                                excess = float(trade.ret - control_mean)
                    else:
                        control_mean = float("nan")
                        excess = float("nan")

                    row = {
                        "market_id": md.market_id,
                        "symbol": md.symbol,
                        "side": side,
                        "trial_id": trial_id,
                        "i0": e.i0,
                        "e_index": e.e_index,
                        "d_index": d_idx,
                        "d_ms": d_ms,
                        "day": day_num,
                        "month": month_str,
                        "usd": e.usd,
                        "rows": e.rows,
                        "duration_min": e.duration_min,
                        "status": trade.status,
                        "ret": trade.ret,
                        "raw_return": trade.raw_return,
                        "funding": trade.funding,
                        "funding_gap": trade.funding_gap,
                        "exit_fallback": trade.exit.fallback,
                        "tie": bool(trade.entry.tie or trade.exit.tie),
                        "tie_entry": trade.entry.tie,
                        "tie_exit": trade.exit.tie,
                        "adverse": trade.adverse,
                        "latency_entry_ms": trade.latency_entry_ms,
                        "latency_exit_ms": trade.latency_exit_ms,
                        "latency_entry": trade.latency_entry_ms,
                        "latency_exit": trade.latency_exit_ms,
                        "entry_ts": trade.entry.ts,
                        "exit_ts": trade.exit.ts,
                        "n_controls": n_ctrls,
                        "control_mean": control_mean,
                        "excess": excess,
                        "class": sym_class,
                    }
                    all_rows.append(row)

                for o in lock.ENTRY_PROFILE_MIN:
                    entry_idx_o = e.e_index + o
                    is_elig_o, _ = eligible(md, xs_valid, xs, entry_idx_o)
                    if is_elig_o:
                        spm_o = spread_median(md, xs_valid, xs, entry_idx_o)
                        for h in lock.EXIT_OFFSETS_MIN:
                            trial_id = f"{side}-{h}"
                            exit_idx_o = e.e_index + h
                            tr_o = simulate_trade(
                                md,
                                xs,
                                spm_o,
                                f_ts,
                                f_rate,
                                side,
                                entry_index=entry_idx_o,
                                exit_index=exit_idx_o,
                            )
                            if tr_o.status == "ok":
                                profile_data[trial_id][o][day_num].append(tr_o.ret)

        del md, xs, xs_valid, liq_prefix, r_pre
        if hasattr(store, "_market_cache") and isinstance(store._market_cache, dict):
            store._market_cache.clear()

    judgement_rng = np.random.default_rng(lock.BOOT_SEED)
    claim_rng = np.random.default_rng(lock.BOOT_SEED + 1)
    trials_dict: dict[str, dict] = {}

    for trial_id in lock.TRIAL_IDS:
        side = trial_id.split("-")[0]
        h = int(trial_id.split("-")[1])
        ok_rows = [r for r in all_rows if r["trial_id"] == trial_id and r["status"] == "ok"]

        day_groups = defaultdict(list)
        for r in ok_rows:
            day_groups[r["day"]].append(r["ret"])
        sorted_days = sorted(day_groups.keys())
        cluster_values = np.array([float(np.mean(day_groups[d])) for d in sorted_days], dtype=np.float64)
        n_clusters = len(cluster_values)
        mean_val = float(np.mean(cluster_values)) if n_clusters > 0 else float("nan")

        boot_bound = bootstrap_bound(
            cluster_values,
            judgement_rng,
            resamples=lock.BOOT_RESAMPLES,
            alpha=lock.TRIAL_ALPHA,
        )
        tb = t_bound(cluster_values, alpha=lock.TRIAL_ALPHA)
        bound_val = float("nan") if (math.isnan(boot_bound) or math.isnan(tb)) else float(min(boot_bound, tb))

        clause_a = bool(not math.isnan(mean_val) and mean_val >= lock.PASS_MIN_MEAN)
        clause_b = bool(not math.isnan(bound_val) and bound_val > lock.PASS_MIN_BOUND)
        clause_c = bool(n_clusters >= lock.MIN_CLUSTERS)

        n_side_elig = side_eligible[side]
        if n_side_elig == 0:
            excluded_share = float("nan")
        else:
            excluded_share = float(side_no_entry_fill[side] / n_side_elig)
        clause_d = bool(not math.isnan(excluded_share) and excluded_share <= lock.MAX_EXCLUDED_SHARE)
        passed = bool(clause_a and clause_b and clause_c and clause_d)

        claim_rows = [r for r in ok_rows if math.isfinite(r["excess"])]
        claim_day_groups = defaultdict(list)
        for r in claim_rows:
            claim_day_groups[r["day"]].append(r["excess"])
        sorted_claim_days = sorted(claim_day_groups.keys())
        claim_cluster_values = np.array(
            [float(np.mean(claim_day_groups[d])) for d in sorted_claim_days],
            dtype=np.float64,
        )
        claim_clusters = len(claim_cluster_values)
        claim_boot = bootstrap_bound(
            claim_cluster_values,
            claim_rng,
            resamples=lock.BOOT_RESAMPLES,
            alpha=lock.CLAIM_ALPHA,
        )
        claim_tb = t_bound(claim_cluster_values, alpha=lock.CLAIM_ALPHA)

        if claim_clusters == 0:
            claim_mean = float("nan")
            claim_bound = float("nan")
            claim_holds = False
        else:
            claim_mean = float(np.mean(claim_cluster_values))
            if math.isnan(claim_boot) or math.isnan(claim_tb):
                claim_bound = float("nan")
                claim_holds = False
            else:
                claim_bound = float(min(claim_boot, claim_tb))
                claim_holds = bool(claim_bound > 0.0)

        # Descriptive statistics
        counts_dict = {
            "bursts": side_bursts[side],
            "candidates": side_candidates[side],
            "events": side_events[side],
            "traded_events": side_traded_events[side],
            "span_end": side_span_end[side],
            "ineligible_by_reason": {
                "activity": side_inelig_activity[side],
                "no_spread_proxy": side_inelig_no_sp[side],
            },
            "eligible": side_eligible[side],
            "no_entry_fill": side_no_entry_fill[side],
            "ok": len(ok_rows),
            "markets": len({r["market_id"] for r in ok_rows}),
            "clusters": n_clusters,
            "no_controls": trial_no_controls[trial_id],
            "funding_gap": sum(1 for r in ok_rows if r["funding_gap"]),
            "exit_fallbacks": sum(1 for r in ok_rows if r["exit_fallback"]),
            "ties": sum(1 for r in ok_rows if r["tie"]),
        }

        durations = [r["duration_min"] for r in ok_rows]
        dur_median = float(np.median(durations)) if durations else float("nan")
        dur_p90 = float(np.percentile(durations, 90)) if durations else float("nan")

        cluster_desc = describe(cluster_values)
        event_desc = describe(np.array([r["ret"] for r in ok_rows], dtype=np.float64))

        if ok_rows:
            usd_arr = np.array([r["usd"] for r in ok_rows], dtype=np.float64)
            ret_arr = np.array([r["ret"] for r in ok_rows], dtype=np.float64)
            sum_usd = float(np.sum(usd_arr))
            vw_mean_ret = float(np.sum(ret_arr * usd_arr) / sum_usd) if sum_usd > 0.0 else float("nan")
        else:
            vw_mean_ret = float("nan")

        month_groups = defaultdict(list)
        for r in ok_rows:
            month_groups[r["month"]].append(r["ret"])
        by_month = {
            m: {
                "n": len(rets),
                "mean_return": float(np.mean(rets)),
            }
            for m, rets in sorted(month_groups.items())
        }

        class_groups = defaultdict(list)
        for r in ok_rows:
            class_groups[r["class"]].append(r["ret"])
        by_class = {
            c: {
                "n": len(rets),
                "mean_return": float(np.mean(rets)),
            }
            for c, rets in sorted(class_groups.items())
        }

        mkt_groups = defaultdict(list)
        for r in ok_rows:
            mkt_groups[(r["market_id"], r["symbol"])].append(r["ret"])
        sorted_mkts = sorted(mkt_groups.items(), key=lambda item: len(item[1]), reverse=True)[:10]
        by_market = [
            {
                "market_id": mid,
                "symbol": sym,
                "n": len(rets),
                "mean_return": float(np.mean(rets)),
            }
            for (mid, sym), rets in sorted_mkts
        ]

        oct10_ts = int(dt.datetime(2025, 10, 10, tzinfo=dt.UTC).timestamp() * 1000)
        oct10_day = oct10_ts // lock.DAY_MS
        no_oct10_rows = [r for r in ok_rows if r["day"] != oct10_day]
        no_oct10_day_groups = defaultdict(list)
        for r in no_oct10_rows:
            no_oct10_day_groups[r["day"]].append(r["ret"])
        no_oct10_clusters = [float(np.mean(v)) for v in no_oct10_day_groups.values()]
        without_2025_10_10 = {
            "n_events": len(no_oct10_rows),
            "n_clusters": len(no_oct10_clusters),
            "cluster_mean": float(np.mean(no_oct10_clusters)) if no_oct10_clusters else float("nan"),
            "event_mean": float(np.mean([r["ret"] for r in no_oct10_rows])) if no_oct10_rows else float("nan"),
        }

        if ok_rows:
            adv_arr = np.array([r["adverse"] for r in ok_rows], dtype=np.float64)
            worst_adv = float(np.max(adv_arr))
            share_adv_2 = float(np.count_nonzero(adv_arr > 0.02) / len(adv_arr))
            share_adv_30 = float(np.count_nonzero(adv_arr > 0.30) / len(adv_arr))
            mean_ret = float(np.mean([r["ret"] for r in ok_rows]))
            cost_minus_2bps_mean = float(mean_ret - 0.0002)
            cost_minus_4bps_mean = float(mean_ret - 0.0004)
            lat_entry_mean = float(np.mean([r["latency_entry_ms"] for r in ok_rows]))
            lat_exit_mean = float(np.mean([r["latency_exit_ms"] for r in ok_rows]))
            funding_sum = float(np.sum([r["funding"] for r in ok_rows]))
        else:
            worst_adv = float("nan")
            share_adv_2 = float("nan")
            share_adv_30 = float("nan")
            cost_minus_2bps_mean = float("nan")
            cost_minus_4bps_mean = float("nan")
            lat_entry_mean = float("nan")
            lat_exit_mean = float("nan")
            funding_sum = 0.0

        profile_dict: dict[str, float] = {}
        for o in lock.ENTRY_PROFILE_MIN:
            o_day_map = profile_data[trial_id][o]
            if o_day_map:
                c_vals = [float(np.mean(rets)) for rets in o_day_map.values()]
                profile_dict[str(o)] = float(np.mean(c_vals))
            else:
                profile_dict[str(o)] = float("nan")

        account_run = simulate_account(ok_rows, max_positions=10, trade_usd=10.0)

        judgement_dict = {
            "mean": mean_val,
            "boot_bound": boot_bound,
            "t_bound": tb,
            "bound": bound_val,
            "n_clusters": n_clusters,
            "excluded_share": excluded_share,
            "clause_a": clause_a,
            "clause_b": clause_b,
            "clause_c": clause_c,
            "clause_d": clause_d,
            "passed": passed,
        }

        claim_dict = {
            "claim_mean": claim_mean,
            "claim_bound": claim_bound,
            "claim_clusters": claim_clusters,
            "claim_holds": claim_holds,
        }

        descriptive_dict = {
            "counts": counts_dict,
            "burst_duration_median": dur_median,
            "burst_duration_p90": dur_p90,
            "cluster_describe": cluster_desc,
            "event_describe": event_desc,
            "volume_weighted_mean_return": vw_mean_ret,
            "by_month": by_month,
            "by_class": by_class,
            "by_market": by_market,
            "without_2025_10_10": without_2025_10_10,
            "worst_adverse": worst_adv,
            "share_adverse_gt_2pct": share_adv_2,
            "share_adverse_gt_30pct": share_adv_30,
            "cost_minus_2bps_mean": cost_minus_2bps_mean,
            "cost_minus_4bps_mean": cost_minus_4bps_mean,
            "latency_entry_mean_ms": lat_entry_mean,
            "latency_exit_mean_ms": lat_exit_mean,
            "funding_sum": funding_sum,
            "entry_offset_profile": profile_dict,
            "account_run": account_run,
        }

        trials_dict[trial_id] = {
            "trial_id": trial_id,
            "side": side,
            "h": h,
            "judgement": judgement_dict,
            "claim": claim_dict,
            "descriptive": descriptive_dict,
            "passed": passed,
            "counts": counts_dict,
            "claim_mean": claim_mean,
            "claim_bound": claim_bound,
            "claim_clusters": claim_clusters,
            "claim_holds": claim_holds,
            "mean": mean_val,
            "boot_bound": boot_bound,
            "t_bound": tb,
            "bound": bound_val,
            "n_clusters": n_clusters,
            "excluded_share": excluded_share,
            "clause_a": clause_a,
            "clause_b": clause_b,
            "clause_c": clause_c,
            "clause_d": clause_d,
        }

    out = {
        "trials": trials_dict,
        "markets": len(market_ids),
        "liq_summary": store.liq_summary(),
        "rows": all_rows,
    }
    return to_json_safe(out)
