"""Simulation of the four trials, aggregation into clusters, pass clauses and descriptive tables (rules 9 and 10)."""

from __future__ import annotations

import dataclasses
import datetime as dt
import math
from collections.abc import Sequence
from typing import Any

import numpy as np

from horizon.e1 import lock, trade
from horizon.e1.events import Pair, first_tag_per_token, record_status
from horizon.e1.stats import Unit, describe, judge_trial, make_clusters

__all__ = ["g0_live_delay_ok", "run_trials"]


def to_json_safe(obj: Any) -> Any:
    """Recursively convert objects to JSON-safe primitives, replacing NaN and inf with None."""
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return to_json_safe(dataclasses.asdict(obj))
    if isinstance(obj, dict):
        return {k: to_json_safe(v) for k, v in obj.items()}
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


def g0_live_delay_ok(trial_result: dict) -> bool:
    """True when trial passed and delay_profile_live_mean >= lock.PASS_MIN_MEAN (rule 9 clause (i))."""
    judgement = trial_result.get("judgement")
    if not isinstance(judgement, dict):
        return False
    if not bool(judgement.get("passed", False)):
        return False
    live_mean = trial_result.get("delay_profile_live_mean")
    if live_mean is None or not isinstance(live_mean, (int, float)) or math.isnan(live_mean):
        return False
    return bool(live_mean >= lock.PASS_MIN_MEAN)


def _reconcile_with_preprint(pairs: Sequence[Pair]) -> dict[str, Any]:
    """First-time class T tags and announcements by year against the preprint's Table 1 (rule 10)."""
    by_year: dict[int, dict[str, Any]] = {}
    for p in pairs:
        if p.cls != lock.CLASS_T:
            continue
        year = dt.datetime.fromtimestamp(p.stamp_ms / 1000, tz=dt.UTC).year
        row = by_year.setdefault(year, {"codes": set(), "tags": 0})
        row["codes"].add(p.code)
        row["tags"] += 1
    out: dict[str, Any] = {}
    for year in sorted(set(by_year) | set(lock.PREPRINT_TABLE1)):
        rec = by_year.get(year, {"codes": set(), "tags": 0})
        pre_events, pre_tags = lock.PREPRINT_TABLE1.get(year, (None, None))
        out[str(year)] = {
            "record_announcements": len(rec["codes"]),
            "record_first_time_tags": rec["tags"],
            "preprint_announcements": pre_events,
            "preprint_first_time_tags": pre_tags,
        }
    return out


def run_trials(
    record: dict,
    pairs: Sequence[Pair],
    store,
    seed: int = lock.BOOT_SEED,
) -> dict:
    """Run four trials and build descriptive report and pairs table."""
    rng = np.random.default_rng(seed)

    # 1. Status counts per class from record checks
    record_status_counts: dict[str, dict[str, int]] = {}
    for c in lock.CLASSES:
        c_pairs = [p for p in pairs if p.cls == c]
        c_no_sym = sum(1 for p in c_pairs if record_status(p) == "no_symbol")
        c_pending = sum(1 for p in c_pairs if record_status(p) == "futures_delist_pending")
        c_missing = sum(1 for p in c_pairs if record_status(p) == "data_missing")
        c_eligible = sum(1 for p in c_pairs if record_status(p) is None)
        record_status_counts[c] = {
            "no_symbol": c_no_sym,
            "futures_delist_pending": c_pending,
            "data_missing": c_missing,
            "eligible_by_record": c_eligible,
        }

    trials: dict[str, dict[str, Any]] = {}
    pairs_rows: list[dict[str, Any]] = []

    # 2. Four trials in TRIAL_IDS order
    for trial_id in lock.TRIAL_IDS:
        cls, h_str = trial_id.split("-")
        h = int(h_str.rstrip("h"))

        cls_all_pairs = [p for p in pairs if p.cls == cls]
        eligible_pairs = [p for p in cls_all_pairs if record_status(p) is None]

        # Rule 2: every excluded pair is listed with its reason, including the ones the record excludes.
        for p in cls_all_pairs:
            status = record_status(p)
            if status is not None:
                pairs_rows.append(
                    {
                        "trial_id": trial_id,
                        "token": p.token,
                        "symbol": p.symbol,
                        "code": p.code,
                        "stamp_ms": p.stamp_ms,
                        "status": "record_excluded",
                        "reason": status,
                    }
                )

        sim_results: list[tuple[Pair, trade.TradeResult]] = []
        for p in eligible_pairs:
            res = trade.simulate(p, store, horizon_hours=h)
            sim_results.append((p, res))

            row = {
                "trial_id": trial_id,
                "token": res.token,
                "symbol": res.symbol,
                "code": p.code,
                "stamp_ms": p.stamp_ms,
                "horizon_hours": res.horizon_hours,
                "delay_minutes": res.delay_minutes,
                "status": res.status,
                "reason": res.reason,
                "entry_ms": res.entry_ms,
                "te_ms": res.te_ms,
                "exit_ms": res.exit_ms,
                "pe": res.pe,
                "px": res.px,
                "be": res.be,
                "bx": res.bx,
                "stopped": res.stopped,
                "truncated": res.truncated,
                "btc_carried": res.btc_carried,
                "funding_gap": res.funding_gap,
                "n_settlements": res.n_settlements,
                "gross_token": res.gross_token,
                "gross_btc": res.gross_btc,
                "fees": res.fees,
                "slippage": res.slippage,
                "funding_token": res.funding_token,
                "funding_btc": res.funding_btc,
                "net": res.net,
                "net_unhedged": res.net_unhedged,
                "net_stress": res.net_stress,
                "max_adverse": res.max_adverse,
            }
            pairs_rows.append(to_json_safe(row))

        ok_results_pairs = [(p, r) for p, r in sim_results if r.status == "ok"]
        ok_results = [r for _, r in ok_results_pairs]
        n_ok = len(ok_results)
        n_activity = sum(1 for _, r in sim_results if r.status == "excluded" and r.reason == "activity")
        n_entry_bar = sum(1 for _, r in sim_results if r.status == "excluded" and r.reason == "entry_bar")
        n_btc_missing = sum(1 for _, r in sim_results if r.status == "excluded" and r.reason == "btc_missing")

        # 3. Rule 9(e) excluded share for this trial
        n_data_missing = record_status_counts[cls]["data_missing"]
        numerator = n_data_missing + n_entry_bar + n_btc_missing
        denominator = n_data_missing + n_ok + n_entry_bar + n_btc_missing
        excluded_share = (float(numerator) / denominator) if denominator > 0 else float("nan")

        # 4. Units and clusters
        code_to_results: dict[str, list[trade.TradeResult]] = {}
        for p, r in ok_results_pairs:
            code_to_results.setdefault(p.code, []).append(r)

        units: list[Unit] = []
        for code, r_list in code_to_results.items():
            mean_net = float(np.mean([r.net for r in r_list]))
            units.append(Unit(cls=cls, code=code, entry_ms=r_list[0].entry_ms, value=mean_net, n_tokens=len(r_list)))

        clusters = make_clusters(units, gap_hours=lock.CLUSTER_GAP_HOURS)
        cluster_net_values = np.array([c.value for c in clusters], dtype=np.float64)

        judgement = judge_trial(trial_id, cluster_net_values, excluded_share, rng)

        # 5. Descriptive tables (rule 10)
        # 5a. Counts
        distinct_codes = {p.code for p in cls_all_pairs}
        counts = {
            "announcements": len(distinct_codes),
            "tokens": len(cls_all_pairs),
            "tokens_with_symbol": sum(1 for p in cls_all_pairs if p.symbol is not None),
            "eligible_by_record": len(eligible_pairs),
            "eligible_tokens": n_ok,
            "simulated": len(sim_results),
            "ok": n_ok,
            "exclusions": {
                "no_symbol": record_status_counts[cls]["no_symbol"],
                "futures_delist_pending": record_status_counts[cls]["futures_delist_pending"],
                "data_missing": n_data_missing,
                "activity": n_activity,
                "entry_bar": n_entry_bar,
                "btc_missing": n_btc_missing,
            },
            "units": len(units),
            "clusters": len(clusters),
            "truncated": sum(1 for r in ok_results if r.truncated),
            "stopped": sum(1 for r in ok_results if r.stopped),
            "btc_carried": sum(1 for r in ok_results if r.btc_carried),
            "funding_gap": sum(1 for r in ok_results if r.funding_gap),
        }

        # 5b. Describe for net, gross hedged, unhedged net, doubled-slippage net
        def _aggregate_metric(metric_fn, code_to_results=code_to_results, cls=cls) -> np.ndarray:
            if not code_to_results:
                return np.array([], dtype=np.float64)
            m_units: list[Unit] = []
            for code, r_list in code_to_results.items():
                val = float(np.mean([metric_fn(r) for r in r_list]))
                m_units.append(Unit(cls=cls, code=code, entry_ms=r_list[0].entry_ms, value=val, n_tokens=len(r_list)))
            m_clusters = make_clusters(m_units, gap_hours=lock.CLUSTER_GAP_HOURS)
            return np.array([c.value for c in m_clusters], dtype=np.float64)

        gross_values = _aggregate_metric(lambda r: r.gross_token + r.gross_btc)
        unhedged_values = _aggregate_metric(lambda r: r.net_unhedged)
        stress_values = _aggregate_metric(lambda r: r.net_stress)

        desc_table = {
            "net": describe(cluster_net_values),
            "gross_hedged": describe(gross_values),
            "unhedged_net": describe(unhedged_values),
            "net_stress": describe(stress_values),
        }

        # 5c. by_year
        year_vals: dict[int, list[float]] = {}
        for c in clusters:
            y = dt.datetime.fromtimestamp(c.entry_ms / 1000, tz=dt.UTC).year
            year_vals.setdefault(y, []).append(c.value)
        by_year = {
            str(y): {"count": len(v_list), "mean": float(np.mean(v_list))} for y, v_list in sorted(year_vals.items())
        }

        # 5d. delay_profile
        # The delay-d statistic is the full trial with another entry minute over the same pairs: the pairs the trial
        # priced successfully. A pair that fails a check at the later entry minute drops out of that delay only.
        delay_profile: dict[str, dict[str, Any]] = {}
        trial_pairs = [p for p, _ in ok_results_pairs]
        for d in lock.DELAY_PROFILE_MINUTES:
            sim_d = [trade.simulate(p, store, horizon_hours=h, delay_minutes=d) for p in trial_pairs]
            ok_d = [(p, r) for p, r in zip(trial_pairs, sim_d, strict=True) if r.status == "ok"]
            code_to_r_d: dict[str, list[trade.TradeResult]] = {}
            for p, r in ok_d:
                code_to_r_d.setdefault(p.code, []).append(r)

            units_d = [
                Unit(
                    cls=cls,
                    code=code,
                    entry_ms=r_list[0].entry_ms,
                    value=float(np.mean([r.net for r in r_list])),
                    n_tokens=len(r_list),
                )
                for code, r_list in code_to_r_d.items()
            ]
            clusters_d = make_clusters(units_d, gap_hours=lock.CLUSTER_GAP_HOURS)
            n_c_d = len(clusters_d)
            mean_c_d = float(np.mean([c.value for c in clusters_d])) if n_c_d > 0 else float("nan")
            delay_profile[str(d)] = {"delay_minutes": d, "n_clusters": n_c_d, "mean": mean_c_d}

        delay_profile_live_mean = delay_profile[str(lock.LIVE_DELAY_MINUTES)]["mean"]

        # 5e. excursion
        adv_arr = np.array([r.max_adverse for r in ok_results], dtype=np.float64)
        if len(adv_arr) == 0:
            excursion = {
                "max": float("nan"),
                "median": float("nan"),
                "p90": float("nan"),
                "count_stop": 0,
                "share_stop": float("nan"),
                "count_liquidation": 0,
                "share_liquidation": float("nan"),
            }
        else:
            c_stop = int(np.count_nonzero(adv_arr >= lock.STOP_ADVERSE))
            c_liq = int(np.count_nonzero(adv_arr >= lock.LIQUIDATION_PROXY_ADVERSE))
            excursion = {
                "max": float(np.max(adv_arr)),
                "median": float(np.median(adv_arr)),
                "p90": float(np.quantile(adv_arr, 0.90, method="linear")),
                "count_stop": c_stop,
                "share_stop": float(c_stop / len(adv_arr)),
                "count_liquidation": c_liq,
                "share_liquidation": float(c_liq / len(adv_arr)),
            }

        # 5f. funding
        if len(ok_results) == 0:
            funding = {"mean": float("nan"), "total": 0.0}
        else:
            f_vals = [r.funding_token + r.funding_btc for r in ok_results]
            funding = {"mean": float(np.mean(f_vals)), "total": float(sum(f_vals))}

        # 5g. futures_delist_before_exit
        fd_notices = sorted(record.get("futures_delist", []), key=lambda x: x.get("ms", 0))
        fd_matches: list[dict[str, Any]] = []
        for p, r in ok_results_pairs:
            for notice in fd_notices:
                n_ms = notice.get("ms", 0)
                if p.stamp_ms <= n_ms <= r.te_ms and r.symbol in notice.get("symbols", []):
                    hours_after = (n_ms - p.stamp_ms) / lock.HOUR_MS
                    fd_matches.append(
                        {
                            "token": r.token,
                            "code": notice.get("code", ""),
                            "hours_after_stamp": hours_after,
                        }
                    )
                    break
        futures_delist_before_exit = {"count": len(fd_matches), "items": fd_matches}

        # 5h. tag_overlap (class D only)
        tag_overlap = None
        if cls == lock.CLASS_D:
            first_tag = first_tag_per_token(list(pairs))
            d_sym_pairs = [p for p in cls_all_pairs if p.symbol is not None]
            prev_tagged_pairs = [p for p in d_sym_pairs if p.token in first_tag and first_tag[p.token] < p.stamp_ms]
            share_tagged = len(prev_tagged_pairs) / len(d_sym_pairs) if d_sym_pairs else 0.0

            prev_ok = [r.net for p, r in ok_results_pairs if p.token in first_tag and first_tag[p.token] < p.stamp_ms]
            never_ok = [
                r.net for p, r in ok_results_pairs if not (p.token in first_tag and first_tag[p.token] < p.stamp_ms)
            ]
            mean_prev = float(np.mean(prev_ok)) if prev_ok else float("nan")
            mean_never = float(np.mean(never_ok)) if never_ok else float("nan")

            first_lags: list[float] = []
            latest_lags: list[float] = []
            events_list = record.get("events", [])
            for p in prev_tagged_pairs:
                first_stamp = first_tag[p.token]
                first_lags.append((p.stamp_ms - first_stamp) / lock.DAY_MS)

                tag_events_before = [
                    ev
                    for ev in events_list
                    if ev.get("cls") == "tag" and p.token in ev.get("tokens", []) and ev.get("ms", 0) < p.stamp_ms
                ]
                if tag_events_before:
                    latest_stamp = max(ev["ms"] for ev in tag_events_before)
                    latest_lags.append((p.stamp_ms - latest_stamp) / lock.DAY_MS)

            med_first = float(np.median(first_lags)) if first_lags else float("nan")
            med_latest = float(np.median(latest_lags)) if latest_lags else float("nan")

            tag_overlap = {
                "share_previously_tagged": share_tagged,
                "mean_net_previously_tagged": mean_prev,
                "mean_net_never_tagged": mean_never,
                "first_tag_lags": first_lags,
                "median_first_tag_lag": med_first,
                "latest_tag_lags": latest_lags,
                "median_latest_tag_lag": med_latest,
            }

        trial_dict: dict[str, Any] = {
            "judgement": dataclasses.asdict(judgement),
            "counts": counts,
            "describe": desc_table,
            "by_year": by_year,
            "delay_profile": delay_profile,
            "delay_profile_live_mean": delay_profile_live_mean,
            "excursion": excursion,
            "funding": funding,
            "futures_delist_before_exit": futures_delist_before_exit,
        }
        if tag_overlap is not None:
            trial_dict["tag_overlap"] = tag_overlap

        trial_dict["g0_ready"] = g0_live_delay_ok(trial_dict)
        trials[trial_id] = trial_dict

    result = {
        "trials": trials,
        "record_status_counts": record_status_counts,
        "reconciliation": _reconcile_with_preprint(pairs),
        "pairs_rows": pairs_rows,
    }
    return to_json_safe(result)
