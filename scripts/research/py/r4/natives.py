"""Phase 4 native re-tests: read the TypeScript replay exports and evaluate the hurdles that apply to a fixed rule.

Calibration spec section 7 and section 12 N7. The closed rules (rv-v1, s1, s2, c1, v8-1h, v8-4h) are re-read, not
re-selected:

- decisions are frozen as exported, with the rule's native costs;
- the span runs from the first refit (2023-01-01) to DEV_END, with betas from the 12 months before each month;
- a hurdle that cannot be computed is "unavailable" and a hurdle that does not apply to a fixed rule is "not
  applicable". Neither is ever counted as passed;
- PBO is not applicable (the rules are not one selection family) and SPA is reported only.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from r4.bar import (
    DEFAULT_JOINT_SHIFT_SEED_BASE,
    DEFAULT_SPA_SEED,
    item3,
    item5,
    joint_shift_null,
    read_manifest,
)
from r4.book import (
    DAY_MS,
    FIVE_MIN_MS,
    Tranche,
    _coerce_tranches,
    beta_hedged_daily,
    daily_close_log_returns,
    daily_series,
    estimate_betas,
)
from r4.cli import (
    _sum_books,
    coin_daily_drift_free,
    cpcv_path_layout,
    folds_to_json,
    reproduction_inputs,
    resolve_commit,
    stress_metrics,
)
from r4.costs import FEE_PROFILES
from r4.data import load_funding, load_perp
from r4.method import (
    BAR,
    CPCV_EMBARGO_MS,
    CPCV_GROUPS,
    CPCV_TEST_GROUPS,
    DEV_END,
    UNIVERSE,
    WF_FIRST_REFIT,
)
from r4.pipeline import FoldRecord
from r4.stats import hansen_spa, per_period_sharpe
from r4.validation import _month_starts, cpcv_path_ids, panel_cpcv_splits

# The span of a re-test: the first refit to DEV_END (exclusive). Tests and the CLI test may narrow it.
WF_SPAN: tuple[int, int] = (WF_FIRST_REFIT, DEV_END)

# Exit reasons the exporter writes. These three are on-grid opens that the book prices at the 5m open.
_HORIZON_REASONS = frozenset({"horizon", "rebalance", "end_of_data"})
_PRICED_REASONS = frozenset({"stop"})
_COST_TOL = 1e-12


@dataclass(frozen=True)
class NativeRule:
    """A closed rule's re-test settings: interval, native taker cost and the item 5 rule."""

    interval: str
    fee_profile: str | None  # None with from_summary: the cost is whatever the export's summary reports
    slippage_bps: float | None
    item5: str  # "jackknife" (dollar-neutral rv-v1) or "coin_count"
    from_summary: bool = False


NATIVE_RULES: dict[str, NativeRule] = {
    "rv-v1": NativeRule("8h", "standard", 2.0, "jackknife"),
    "s1": NativeRule("1h", "standard", 2.0, "coin_count"),
    "s2": NativeRule("1h", "standard", 2.0, "coin_count"),
    "c1": NativeRule("1h", "standard", 3.0, "coin_count"),
    "v8-1h": NativeRule("1h", None, None, "coin_count", from_summary=True),
    "v8-4h": NativeRule("4h", None, None, "coin_count", from_summary=True),
}


def _profile_from_costs(fee_taker: float, fee_maker: float | None) -> str:
    """The fee profile whose taker (and maker, when reported) fee equals the export's reported fees."""
    for name, prof in FEE_PROFILES.items():
        if prof.symbols is not None:
            continue
        if abs(prof.taker_fee - fee_taker) > _COST_TOL:
            continue
        if fee_maker is not None and abs(prof.maker_fee - fee_maker) > _COST_TOL:
            continue
        return name
    raise ValueError(f"No fee profile has taker {fee_taker} and maker {fee_maker}: the export's native cost is unknown")


def _native_cost(rule: str, summary: Mapping[str, Any]) -> tuple[str, float]:
    """(fee profile, slippage bps) of a rule. A fixed rule's table is checked against the summary's own costs."""
    spec = NATIVE_RULES[rule]
    costs = summary.get("costs")
    if not isinstance(costs, Mapping) or "fee_taker" not in costs or "slippage_bps" not in costs:
        raise ValueError(f"{rule}: summary has no costs block with fee_taker and slippage_bps")
    fee_taker = float(costs["fee_taker"])
    fee_maker = None if costs.get("fee_maker") is None else float(costs["fee_maker"])
    slippage = float(costs["slippage_bps"])
    if spec.from_summary:
        return _profile_from_costs(fee_taker, fee_maker), slippage
    assert spec.fee_profile is not None and spec.slippage_bps is not None
    want_fee = FEE_PROFILES[spec.fee_profile].taker_fee
    if abs(fee_taker - want_fee) > _COST_TOL or abs(slippage - spec.slippage_bps) > _COST_TOL:
        raise ValueError(
            f"{rule}: the summary's cost (taker {fee_taker}, slippage {slippage} bps) is not the rule's native cost "
            f"(taker {want_fee}, slippage {spec.slippage_bps} bps)"
        )
    return spec.fee_profile, spec.slippage_bps


def _grid_ms(value: Any, field: str, line: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or float(value) != int(value):
        raise ValueError(f"line {line}: {field} {value!r} is not an integer millisecond time")
    ms = int(value)
    if ms % FIVE_MIN_MS != 0:
        raise ValueError(f"line {line}: {field} {ms} is not a multiple of {FIVE_MIN_MS} ms (the 5m grid)")
    return ms


def read_export(export_dir: Path | str, dataset_hash: str) -> tuple[list[Tranche], dict[str, Any], dict[str, Any]]:
    """Read tranches.jsonl and summary.json of a native export into book tranches.

    Every row becomes a Tranche with weight_override = weight and the rule's native cost. "horizon", "rebalance" and
    "end_of_data" exits are on-grid opens that the book prices at the 5m open (exit_reason "horizon"). A "stop" keeps
    its exit price and stays a priced exit. A stop with no exit price (a v8 stop) cannot be booked and is dropped and
    counted. Returns (tranches, summary, dropped).
    """
    root = Path(export_dir)
    summary = json.loads((root / "summary.json").read_text(encoding="utf-8"))
    rule = summary.get("rule")
    if rule not in NATIVE_RULES:
        raise ValueError(f"Unknown rule in the export summary: {rule!r}")
    if summary.get("manifest_hash") != dataset_hash:
        raise ValueError(
            f"{rule}: the export's manifest_hash {summary.get('manifest_hash')!r} is not the dataset manifest's "
            f"datasetHash {dataset_hash!r}"
        )
    fee_profile, slippage = _native_cost(rule, summary)
    interval = NATIVE_RULES[rule].interval

    tranches: list[Tranche] = []
    unpriced_stop = 0
    total = 0
    for line_no, line in enumerate((root / "tranches.jsonl").read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        row = json.loads(line)
        total += 1
        if row.get("rule") != rule:
            raise ValueError(f"line {line_no}: rule {row.get('rule')!r} is not the summary's rule {rule!r}")
        entry_ms = _grid_ms(row["entry_ms"], "entry_ms", line_no)
        exit_ms = _grid_ms(row["exit_ms"], "exit_ms", line_no)
        if exit_ms <= entry_ms:
            raise ValueError(f"line {line_no}: exit_ms {exit_ms} is not after entry_ms {entry_ms}")
        reason = row["exit_reason"]
        exit_price = row.get("exit_price")
        if reason in _HORIZON_REASONS:
            booked_reason = "horizon"
            if exit_price is None:
                raise ValueError(f"line {line_no}: a {reason} exit has no exit_price")
        elif reason in _PRICED_REASONS:
            booked_reason = reason
            if exit_price is None:
                unpriced_stop += 1
                continue
        else:
            raise ValueError(f"line {line_no}: unknown exit_reason {reason!r}")
        tranches.append(
            Tranche(
                symbol=str(row["symbol"]),
                side=int(row["side"]),
                entry_ms=entry_ms,
                exit_ms=exit_ms,
                entry_price=float(row["entry_price"]),
                exit_price=float(exit_price),
                interval=interval,
                h_ms=exit_ms - entry_ms,
                exit_reason=booked_reason,
                weight_override=float(row["weight"]),
                fee_profile=fee_profile,
                slippage_bps_override=slippage,
            )
        )
    dropped = {
        "unpriced_stop": unpriced_stop,
        "total_rows": total,
        "share": (unpriced_stop / total) if total else 0.0,
    }
    return tranches, summary, dropped


def mechanical_parity(summary: Mapping[str, Any]) -> dict[str, Any]:
    """The export's own counts and means against the recorded references (29a's parity block), for the lead to judge."""
    parity = summary.get("parity")
    if not isinstance(parity, Mapping):
        raise ValueError("The export summary has no parity block")
    out: dict[str, Any] = {
        "rule": summary.get("rule"),
        "n_tranches": summary.get("n_tranches"),
        "mean_net_native": summary.get("mean_net_native"),
        "parity": dict(parity),
    }
    for key in ("n_steps", "sharpe_ann", "exit_price_unavailable"):
        if key in summary:
            out[key] = summary[key]
    return out


# ------------------------------------------------------------------------------------------------ evaluation


def _clean(value: Any) -> Any:
    """JSON-safe copy: numpy scalars to Python, NaN and infinities to None, keys to str."""
    if isinstance(value, Mapping):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    if isinstance(value, np.ndarray):
        return [_clean(v) for v in value.tolist()]
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    if isinstance(value, (np.integer, int)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        f = float(value)
        return f if math.isfinite(f) else None
    return value


def summarise_hurdles(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Pass rule: every APPLIED hurdle passes. Unavailable and not applicable hurdles are never counted as passed.

    With no applied hurdle there is nothing to pass. fully_assessed is False when any hurdle is unavailable.
    """
    passed = [str(r["test"]) for r in rows if r["status"] == "applied" and r["pass"]]
    failed = [str(r["test"]) for r in rows if r["status"] == "applied" and not r["pass"]]
    unavailable = [str(r["test"]) for r in rows if r["status"] == "unavailable"]
    not_applicable = [str(r["test"]) for r in rows if r["status"] == "not applicable"]
    return {
        "pass": bool(passed) and not failed,
        "hurdles_passed": passed,
        "hurdles_failed": failed,
        "hurdles_unavailable": unavailable,
        "hurdles_not_applicable": not_applicable,
        "fully_assessed": not unavailable,
    }


def _applied(item: int, test: str, passed: bool, **extra: Any) -> dict[str, Any]:
    return {"item": item, "test": test, "status": "applied", "pass": bool(passed), **extra}


def _skipped(item: int, test: str, status: str, reason: str) -> dict[str, Any]:
    return {"item": item, "test": test, "status": status, "reason": reason}


def _seeds(seed_cfg: int | Mapping[str, int] | None) -> tuple[int, int]:
    if seed_cfg is None:
        return DEFAULT_JOINT_SHIFT_SEED_BASE, DEFAULT_SPA_SEED
    if isinstance(seed_cfg, Mapping):
        return (
            int(seed_cfg.get("joint_shift", DEFAULT_JOINT_SHIFT_SEED_BASE)),
            int(seed_cfg.get("spa", DEFAULT_SPA_SEED)),
        )
    return int(seed_cfg), DEFAULT_SPA_SEED


def _month_cut(start_ms: int, months: int) -> int:
    dt = pd.to_datetime(start_ms, unit="ms", utc=True) - pd.DateOffset(months=months)
    return int(dt.timestamp() * 1000)


def _cpcv_fixed_rule(
    in_span: list[Tranche],
    daily_ret: pd.DataFrame,
    five_min: dict[str, pd.DataFrame],
    settlements: Any,
    universe: list[str],
) -> dict[str, Any]:
    """CPCV for a fixed rule: 6 groups, 2 test groups, M's purge and embargo, split betas from the training set."""
    t0 = np.array([t.entry_ms for t in in_span], dtype=np.int64)
    t1 = np.array([t.exit_ms for t in in_span], dtype=np.int64)
    if len(np.unique(t0)) < CPCV_GROUPS:
        return {"status": "unavailable", "reason": f"fewer than {CPCV_GROUPS} distinct entry times"}
    splits = list(
        panel_cpcv_splits(t0, t1, n_groups=CPCV_GROUPS, n_test_groups=CPCV_TEST_GROUPS, embargo_ms=CPCV_EMBARGO_MS)
    )
    split_betas: list[dict[str, float]] = []
    tests_by_split: list[list[np.ndarray]] = []
    for train_idx, test_list in splits:
        train_days = sorted({(int(t) // DAY_MS) * DAY_MS for t in t0[train_idx]})
        split_betas.append(estimate_betas(daily_ret.loc[daily_ret.index.isin(train_days)]))
        tests_by_split.append(test_list)
    path_ids = cpcv_path_ids(CPCV_GROUPS, CPCV_TEST_GROUPS)
    layout = cpcv_path_layout(path_ids, CPCV_GROUPS, CPCV_TEST_GROUPS)
    n_paths = int(path_ids.max()) + 1
    span_start = (int(t0.min()) // DAY_MS) * DAY_MS
    span_end = (int(t1.max()) // DAY_MS + 1) * DAY_MS
    means: list[float] = []
    for path in range(n_paths):
        frames: list[pd.DataFrame] = []
        for (p, _g), (s, j) in sorted(layout.items()):
            if p != path:
                continue
            idx = np.asarray(tests_by_split[s][j], dtype=int)
            if len(idx) == 0:
                continue
            sub = [in_span[i] for i in idx]
            frames.append(beta_hedged_daily(sub, five_min, settlements, betas=split_betas[s], universe=universe))
        series = daily_series(_sum_books(frames), "drift_free", span_start_ms=span_start, span_end_ms=span_end)
        means.append(float(series["drift_free"].mean()))
    positive = sum(1 for m in means if m > 0.0)
    required = int(BAR["cpcv_paths_positive_min"])
    return {
        "status": "applied",
        "n_splits": len(splits),
        "path_means": means,
        "positive_paths": positive,
        "min_positive_required": required,
        "pass": bool(positive >= required),
    }


def evaluate_retest(
    rule: str,
    tranches: Sequence[Tranche],
    panel: dict[str, dict[str, pd.DataFrame]],
    calib_v: float,
    n_trials: int = 120,
    seed_cfg: int | Mapping[str, int] | None = None,
    *,
    summary: Mapping[str, Any] | None = None,
    dropped: Mapping[str, Any] | None = None,
    dataset_hash: str | None = None,
    commit: str | None = None,
    span_start: int | None = None,
    span_end: int | None = None,
    lookback_months: int = 12,
    n_draws: int | None = None,
) -> dict[str, Any]:
    """Evaluate the hurdles that apply to a fixed rule, as a labelled re-read (receipt kind "retest").

    Span: tranches with entry in [span_start, span_end), by default the first refit to DEV_END. Monthly folds with
    betas from the lookback_months before each month's start. The drift-free series is the folds' beta_hedged_daily
    summed by day and reindexed to every calendar day of the span, no-bet days as 0.

    seed_cfg is an int (the joint-shift seed) or a mapping with "joint_shift" and "spa" seeds.
    """
    if rule not in NATIVE_RULES:
        raise ValueError(f"Unknown rule: {rule!r}")
    start = WF_SPAN[0] if span_start is None else int(span_start)
    end = WF_SPAN[1] if span_end is None else int(span_end)
    draws = int(BAR["random_entry_draws"]) if n_draws is None else int(n_draws)
    joint_seed, spa_seed = _seeds(seed_cfg)
    spec = NATIVE_RULES[rule]
    commit_sha = resolve_commit(commit)

    all_tranches = _coerce_tranches(list(tranches))
    for t in all_tranches:
        if t.symbol not in panel:
            raise ValueError(f"Tranche symbol {t.symbol} is not in the panel")
    in_span = [t for t in all_tranches if start <= t.entry_ms < end]
    n_out = len(all_tranches) - len(in_span)
    if not in_span:
        raise ValueError(f"{rule}: no tranche enters in [{start}, {end})")

    universe = list(panel)
    five_min = {s: panel[s]["5m"] for s in universe}
    settlements = {s: panel[s].get("settlements", panel[s].get("funding")) for s in universe}

    all_ts = [int(df["t"].min()) for df in five_min.values() if not df.empty]
    all_te = [int(df["t"].max()) for df in five_min.values() if not df.empty]
    min_d = (min(all_ts) // DAY_MS) * DAY_MS
    max_d = ((max(all_te) // DAY_MS) + 1) * DAY_MS
    daily_ret = daily_close_log_returns(five_min, list(range(min_d, max_d + DAY_MS, DAY_MS)), universe)

    # Monthly folds. Every month of the span gets a fold, empty or not, because the joint-shift null lands shifted
    # tranches in any month and needs that month's betas.
    boundaries = sorted({start, end, *_month_starts(start, end)})
    folds: list[FoldRecord] = []
    for b0, b1 in zip(boundaries[:-1], boundaries[1:], strict=True):
        fold_tr = [t for t in in_span if b0 <= t.entry_ms < b1]
        cut = _month_cut(b0, lookback_months)
        betas = estimate_betas(daily_ret, start_ms=cut, end_ms=b0)
        book = beta_hedged_daily(fold_tr, five_min, settlements, betas=betas, universe=universe)
        folds.append(FoldRecord(b0, b1, cut, dict(betas), fold_tr, book))

    wf = daily_series(
        _sum_books([f.book for f in folds if len(f.book)]), "drift_free", span_start_ms=start, span_end_ms=end
    )
    series = wf["drift_free"]
    values = series.to_numpy(dtype=np.float64)
    wf_mean = float(series.mean())
    wf_sharpe = per_period_sharpe(values)

    rows: list[dict[str, Any]] = []

    # Item 1
    item1_wf = {"wf_mean": wf_mean, "pass": bool(wf_mean > 0.0)}
    rows.append(_applied(1, "walk_forward_mean", item1_wf["pass"], value=wf_mean))
    cpcv = _cpcv_fixed_rule(in_span, daily_ret, five_min, settlements, universe)
    if cpcv["status"] == "applied":
        rows.append(_applied(1, "cpcv_paths", cpcv["pass"], value=cpcv["positive_paths"]))
    else:
        rows.append(_skipped(1, "cpcv_paths", "unavailable", cpcv["reason"]))

    # Item 2
    item2 = {
        "status": "not applicable",
        "reason": "a single fixed rule has no selection among configurations, so PBO has no matrix to rank",
    }
    rows.append(_skipped(2, "pbo", "not applicable", item2["reason"]))

    # Item 3: the calibration DSR with the within-cell V and N = 120, labelled a Phase 4 re-read.
    d3 = item3({}, float(calib_v), int(n_trials), candidate_daily=pd.DataFrame({"drift_free": series}))
    item3_out = {**d3, "phase4_reread": True, "calib_v": float(calib_v)}
    rows.append(_applied(3, "deflated_sharpe", d3["pass"], value=d3["dsr_prob"]))

    # Item 4
    jsd = [t for t in in_span]
    stops = sum(1 for t in jsd if t.exit_reason != "horizon")
    if stops:
        joint: dict[str, Any] = {
            "status": "unavailable",
            "reason": (
                f"{stops} priced stop tranches remain: the native stop is not an engine rule, so the joint-shift "
                "null cannot replay it"
            ),
        }
        rows.append(_skipped(4, "joint_shift_null", "unavailable", joint["reason"]))
    else:
        p_val, drop_share, observed, _shifts = joint_shift_null(
            tranches=jsd,
            panel=panel,
            folds=folds_to_json(folds),
            span_start_ms=start,
            span_end_ms=end,
            n_draws=draws,
            min_shift_days=int(BAR["random_entry_shift_min_days"]),
            seed=joint_seed,
        )
        passed = bool(p_val < float(BAR["random_entry_p_max"]))
        joint = {
            "status": "applied",
            "pass": passed,
            "p": float(p_val),
            "drop_share": float(drop_share),
            "observed": observed,
            "draws": draws,
            "seed": joint_seed,
        }
        rows.append(_applied(4, "joint_shift_null", passed, value=float(p_val)))
    spa_reason = "family-level and reported only (retest_family_spa), it is not a hurdle of one rule"
    rows.append(_skipped(4, "spa", "not applicable", spa_reason))
    tripwire = "not applicable: a fixed rule has no training, so there is no label to shift"
    rows.append(_skipped(4, "label_shift_tripwire", "not applicable", tripwire))

    # Item 5
    coin_means: dict[str, float | None] = {}
    jackknife: dict[str, float] = {}
    for sym in UNIVERSE:
        coin_series = coin_daily_drift_free(folds, sym, five_min, settlements, universe, start, end)
        if coin_series is None:
            coin_means[sym] = None
            jackknife[sym] = wf_mean
        else:
            coin_means[sym] = float(coin_series.mean())
            jackknife[sym] = float((series - coin_series).mean())
    if spec.item5 == "jackknife":
        d5 = item5({"metrics": {"jackknife_means": jackknife}, "config": {"book": "D"}})
        item5_out = {**d5, "jackknife_means": jackknife, "coin_means": coin_means}
        rows.append(_applied(5, "drop_one_coin_jackknife", d5["pass"], value=d5["jackknife_positive"]))
    else:
        d5 = item5({"metrics": {"coin_means": coin_means}, "config": {}})
        item5_out = {**d5, "coin_means": coin_means}
        rows.append(_applied(5, "coin_breadth", d5["pass"], value=d5["positive_coins"]))

    # Item 6: fees x1.5 and slippage x2 on the native costs.
    stress = stress_metrics(folds, wf, start, end)
    pass_cost = bool(stress["stress_cost"] >= 0.0)
    rows.append(_applied(6, "stress_cost", pass_cost, value=stress["stress_cost"]))
    if int(stress["n_maker_fills"]) == 0:
        maker: dict[str, Any] = {"status": "not applicable", "reason": "no maker fills in the native replay"}
        rows.append(_skipped(6, "maker_as_taker", "not applicable", maker["reason"]))
    else:
        pass_maker = bool(stress["stress_maker_as_taker"] >= 0.0)
        maker = {"status": "applied", "value": stress["stress_maker_as_taker"], "pass": pass_maker}
        rows.append(_applied(6, "maker_as_taker", pass_maker, value=stress["stress_maker_as_taker"]))

    folds_out = [
        {**f, "beta_window": {"start_ms": fr.train_cut_ms, "end_ms": fr.start_ms}}
        for f, fr in zip(folds_to_json(folds), folds, strict=True)
    ]
    receipt: dict[str, Any] = {
        "kind": "retest",
        "rule": rule,
        "commit": commit_sha,
        **reproduction_inputs(),
        "dataset_hash": dataset_hash,
        "export_summary_sha256": None
        if summary is None
        else hashlib.sha256(json.dumps(summary, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest(),
        "native_cost": {
            "fee_profile": spec.fee_profile,
            "slippage_bps": spec.slippage_bps,
            "from_summary": spec.from_summary,
        },
        "span": {"start_ms": start, "end_ms": end},
        "lookback_months": lookback_months,
        "n_tranches": len(in_span),
        "n_out_of_span": n_out,
        "n_days": len(series),
        "bet_days": int(wf["bet"].sum()),
        "wf_mean": wf_mean,
        "wf_sharpe": wf_sharpe,
        "calib_v": float(calib_v),
        "n_trials": int(n_trials),
        "dropped": None if dropped is None else dict(dropped),
        "folds": folds_out,
        "daily_drift_free": {"start_ms": start, "values": values.tolist()},
        "item1": {"walk_forward": item1_wf, "cpcv": cpcv},
        "item2": item2,
        "item3": item3_out,
        "item4": {
            "joint_shift": joint,
            "spa": {"status": "not applicable", "reason": spa_reason},
            "label_shift_tripwire": tripwire,
        },
        "item5": item5_out,
        "item6": {
            "stress_cost": stress["stress_cost"],
            "stress_fee": stress["stress_fee"],
            "stress_slippage": stress["stress_slippage"],
            "pass": pass_cost,
            "n_maker_fills": stress["n_maker_fills"],
            "maker_as_taker": maker,
        },
        "hurdles": rows,
        **summarise_hurdles(rows),
        "seeds": {"joint_shift": joint_seed, "spa": spa_seed},
    }
    if summary is not None:
        receipt["parity"] = mechanical_parity(summary)
    return _clean(receipt)  # type: ignore[no-any-return]


def retest_family_spa(receipts: Mapping[str, Mapping[str, Any]], seed: int = DEFAULT_SPA_SEED) -> dict[str, Any]:
    """SPA on the matrix of the rules' drift-free series over their common span. Reported only. PBO not applicable."""
    if not receipts:
        raise ValueError("retest_family_spa needs at least one receipt")
    names = sorted(receipts)
    starts = [int(receipts[n]["daily_drift_free"]["start_ms"]) for n in names]
    ends = [s + len(receipts[n]["daily_drift_free"]["values"]) * DAY_MS for s, n in zip(starts, names, strict=True)]
    common_start, common_end = max(starts), min(ends)
    if common_start >= common_end:
        raise ValueError("The receipts have no common span")
    days = range(common_start, common_end, DAY_MS)
    cols = []
    for n, s in zip(names, starts, strict=True):
        vals = receipts[n]["daily_drift_free"]["values"]
        cols.append(
            np.array([0.0 if v is None else v for v in vals[(common_start - s) // DAY_MS : (common_end - s) // DAY_MS]])
        )
    matrix = np.column_stack(cols)
    spa_t, spa_p = hansen_spa(
        matrix, n_reps=int(BAR["spa_reps"]), mean_block_len=float(BAR["spa_mean_block_days"]), seed=seed
    )
    return _clean(
        {
            "reported_only": True,
            "n_rules": len(names),
            "rules": names,
            "common_span": {"start_ms": common_start, "end_ms": common_end, "n_days": len(days)},
            "spa_t": spa_t,
            "spa_p": spa_p,
            "seed": seed,
            "pbo": f"not applicable: the {len(names)} rules are not one selection family",
        }
    )  # type: ignore[no-any-return]


def run_retest(
    export_dir: Path | str,
    ds_dir: Path | str,
    calib_v: float,
    out_dir: Path | str,
    commit: str | None = None,
    seed_cfg: int | Mapping[str, int] | None = None,
    n_draws: int | None = None,
) -> dict[str, Any]:
    """Read one export, load the dataset's 5m opens and funding, evaluate, and write out_dir/<rule>/receipt.json."""
    ds_path = Path(ds_dir)
    manifest = read_manifest(ds_path)
    dataset_hash = str(manifest["datasetHash"])
    tranches, summary, dropped = read_export(export_dir, dataset_hash)
    symbols = list(manifest["symbols"]) if manifest.get("symbols") else list(UNIVERSE)
    panel: dict[str, dict[str, pd.DataFrame]] = {}
    for sym in symbols:
        fund = load_funding(ds_path, sym).rows
        panel[sym] = {"5m": load_perp(ds_path, sym, "5m", series="klines").rows, "settlements": fund, "funding": fund}
    receipt = evaluate_retest(
        str(summary["rule"]),
        tranches,
        panel,
        calib_v,
        seed_cfg=seed_cfg,
        summary=summary,
        dropped=dropped,
        dataset_hash=dataset_hash,
        commit=commit,
        n_draws=n_draws,
    )
    target = Path(out_dir) / str(summary["rule"])
    target.mkdir(parents=True, exist_ok=True)
    (target / "receipt.json").write_text(json.dumps(receipt, indent=2, allow_nan=False), encoding="utf-8")
    return receipt
