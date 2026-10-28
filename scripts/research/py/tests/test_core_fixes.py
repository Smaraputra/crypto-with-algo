"""Brief 28d-1: netting split (intrabar vs open), one netting set per run, funding at an intrabar stamp."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

import r4.book as book
from r4.bar import _unit_costs, cell_key, family_report, joint_shift_null
from r4.book import DAY_MS, Tranche
from r4.cli import main, run_tripwire, run_wf
from r4.method import UNIVERSE
from tests.test_cli_bar import _small_run, _write_planted_family
from tests.test_tripwire import _cov, _small_dataset

HOUR = 3_600_000
MIN = 60_000
DAY0 = 1_700_006_400_000  # a UTC midnight
TAKER = 0.0005
BTC_SLIP = 0.0001
W = 1.0 / 4.0 / 10.0  # size 1, h 4h at 1h


def _t(
    sym="BTCUSDT",
    side=1,
    entry=0,
    exit_=0,
    reason="horizon",
    exit_fill="taker",
    entry_fill="taker",
    h_ms=4 * HOUR,
) -> Tranche:
    return Tranche(
        symbol=sym,
        side=side,
        entry_ms=DAY0 + entry,
        exit_ms=DAY0 + exit_,
        entry_price=100.0,
        exit_price=101.0,
        interval="1h",
        h_ms=h_ms,
        entry_fill=entry_fill,
        exit_fill=exit_fill,
        exit_reason=reason,
    )


# ---------------------------------------------------------------------------
# Finding 5: intrabar fills never net
# ---------------------------------------------------------------------------


def test_intrabar_stop_at_entry_instant_pays_both_fills():
    stamp = 5 * HOUR + 10 * MIN
    stopped = _t(entry=1 * HOUR + 10 * MIN, exit_=stamp, reason="stop")
    fresh = _t(entry=stamp, exit_=stamp + 4 * HOUR)
    n = book.netted_costs([stopped, fresh])
    rate = TAKER + BTC_SLIP
    at_stamp = n.groups[n.groups["instant_ms"] == DAY0 + stamp]
    assert len(at_stamp) == 2
    assert at_stamp["traded"].to_numpy() == pytest.approx([W, W], abs=1e-15)
    assert n.tranche_cost[0] == pytest.approx(2 * W * rate, abs=1e-15)  # entry leg and stop leg
    assert n.tranche_cost[1] == pytest.approx(2 * W * rate, abs=1e-15)  # entry leg and horizon leg
    assert float(n.by_day["fees"].sum() + n.by_day["slippage"].sum()) == pytest.approx(4 * W * rate, abs=1e-15)


def test_open_price_roll_still_nets():
    stamp = 5 * HOUR + 10 * MIN
    for reason in ("horizon", "model_exit", "flow_exit", "funding_exit"):
        expiring = _t(entry=1 * HOUR + 10 * MIN, exit_=stamp, reason=reason)
        fresh = _t(entry=stamp, exit_=stamp + 4 * HOUR)
        n = book.netted_costs([expiring, fresh])
        roll = n.groups[n.groups["instant_ms"] == DAY0 + stamp]
        assert len(roll) == 1, reason
        assert roll["traded"].iloc[0] == pytest.approx(0.0, abs=1e-15), reason


@pytest.mark.parametrize("reason", ["stop", "take_profit", "maker_exit"])
def test_intrabar_fills_do_not_net_with_each_other(reason):
    stamp = 5 * HOUR + 10 * MIN
    fill = "maker" if reason != "stop" else "taker"
    long_ = _t(side=1, entry=1 * HOUR, exit_=stamp, reason=reason, exit_fill=fill)
    short = _t(side=-1, entry=2 * HOUR, exit_=stamp, reason=reason, exit_fill=fill)
    n = book.netted_costs([long_, short])
    at_stamp = n.groups[n.groups["instant_ms"] == DAY0 + stamp]
    assert len(at_stamp) == 2
    assert at_stamp["traded"].to_numpy() == pytest.approx([W, W], abs=1e-15)


def test_maker_as_taker_relabelled_x1_fill_stays_intrabar():
    stamp = 5 * HOUR + 10 * MIN
    x1 = _t(side=1, entry=1 * HOUR, exit_=stamp, reason="maker_exit", exit_fill="maker")
    fresh = _t(side=1, entry=stamp, exit_=stamp + 4 * HOUR)
    plain = book.netted_costs([x1, fresh], maker_as_taker=True)
    at_stamp = plain.groups[plain.groups["instant_ms"] == DAY0 + stamp]
    assert len(at_stamp) == 2
    assert (at_stamp["fill"] == "taker").all()
    assert at_stamp["traded"].to_numpy() == pytest.approx([W, W], abs=1e-15)


def test_vectorised_twin_matches_netted_costs_with_intrabar():
    stamp = 5 * HOUR + 10 * MIN
    rows = [
        _t(entry=1 * HOUR + 10 * MIN, exit_=stamp, reason="stop"),
        _t(entry=stamp, exit_=stamp + 4 * HOUR),
        _t(entry=2 * HOUR + 10 * MIN, exit_=stamp, reason="horizon"),
        _t(side=-1, entry=3 * HOUR, exit_=stamp, reason="take_profit", exit_fill="maker"),
        _t(sym="ETHUSDT", entry=stamp, exit_=stamp + 4 * HOUR),
    ]
    got = _unit_costs(rows, "standard")
    ref = book.netted_costs(rows, "standard")
    w_abs = np.array([abs(t.weight) for t in rows])
    assert got == pytest.approx(ref.tranche_cost / w_abs, abs=1e-15)


# ---------------------------------------------------------------------------
# Finding 10: funding at an intrabar stamp
# ---------------------------------------------------------------------------

SETTLE = DAY0 + 8 * HOUR
RATE = 0.001


def _settle_frame() -> pd.DataFrame:
    return pd.DataFrame({"t": [SETTLE], "rate": [RATE]})


def _five_min() -> dict[str, pd.DataFrame]:
    n = 3 * 288
    t = DAY0 - DAY_MS + np.arange(n, dtype=np.int64) * 300_000
    return {s: pd.DataFrame({"t": t, "o": np.full(n, 100.0)}) for s in UNIVERSE[:6]}


def _funding_tranche(reason: str) -> Tranche:
    return Tranche(
        "BTCUSDT",
        1,
        DAY0 + 6 * HOUR,
        SETTLE,
        100.0,
        100.0,
        "1h",
        4 * HOUR,
        exit_reason=reason,
    )


@pytest.mark.parametrize(
    ("reason", "paid"),
    [("stop", False), ("take_profit", False), ("maker_exit", False), ("horizon", True), ("model_exit", True)],
)
def test_funding_window_at_the_stamp(reason, paid):
    tr = _funding_tranche(reason)
    expected = -tr.weight * RATE if paid else 0.0
    five = _five_min()
    day = book.daily_book([tr], five, {"BTCUSDT": _settle_frame()})
    assert float(day["funding"].sum()) == pytest.approx(expected, abs=1e-15)
    betas = {s: 1.0 for s in UNIVERSE[:6]}
    hedged = book.beta_hedged_daily([tr], five, {"BTCUSDT": _settle_frame()}, betas, UNIVERSE[:6])
    assert float(hedged["funding"].sum()) == pytest.approx(expected, abs=1e-15)
    trades = book.trade_level([tr], {"BTCUSDT": _settle_frame()})
    net = float(trades["net_return"].iloc[0])
    cost = float(book.netted_costs([tr]).tranche_cost[0] / abs(tr.weight))
    assert net == pytest.approx(0.0 - tr.side_val * (RATE if paid else 0.0) - cost, abs=1e-15)


def test_funding_stamp_rule_in_joint_shift_observed(monkeypatch):
    import r4.bar as bar

    monkeypatch.setattr(bar, "_refuse_path_exits", lambda tranche_list: None)
    start = DAY0 - 10 * DAY_MS
    n_days = 100
    t = start + np.arange(n_days * 288, dtype=np.int64) * 300_000
    flat = {
        s: {"5m": pd.DataFrame({"t": t, "o": np.full(len(t), 100.0)}), "settlements": _settle_frame()}
        for s in UNIVERSE[:6]
    }
    folds = [
        {
            "start_ms": start,
            "end_ms": start + n_days * DAY_MS,
            "train_cut_ms": None,
            "betas": {s: 1.0 for s in UNIVERSE},
        }
    ]
    out = {}
    for reason in ("stop", "horizon"):
        tr = [_funding_tranche(reason)]
        _p, _d, obs, _ = joint_shift_null(tr, flat, folds, start, start + n_days * DAY_MS, n_draws=5, seed=3)
        out[reason] = obs
    cost = float(book.netted_costs([_funding_tranche("stop")]).tranche_cost[0] / abs(_funding_tranche("stop").weight))
    assert out["stop"] == pytest.approx(-cost, abs=1e-12)
    assert out["horizon"] == pytest.approx(-cost - RATE, abs=1e-12)


# ---------------------------------------------------------------------------
# Finding 11: one netting set per run
# ---------------------------------------------------------------------------


def test_leg_costs_net_a_cross_fold_roll():
    stamp = DAY0 + 5 * HOUR + 10 * MIN
    a = _t(entry=1 * HOUR + 10 * MIN, exit_=5 * HOUR + 10 * MIN)
    b = _t(entry=5 * HOUR + 10 * MIN, exit_=9 * HOUR + 10 * MIN)
    five = _five_min()
    betas = {s: 1.0 for s in UNIVERSE[:6]}
    universe = UNIVERSE[:6]
    run_legs = book.LegCosts.from_netted(book.netted_costs([a, b]), [0, 1], 2)
    fold1 = book.beta_hedged_daily([a], five, {}, betas, universe, leg_costs=run_legs.take(0, 1))
    fold2 = book.beta_hedged_daily([b], five, {}, betas, universe, leg_costs=run_legs.take(1, 2))
    rate = TAKER + BTC_SLIP
    assert stamp  # the roll instant
    run_level = float(fold1["costs"].sum() + fold2["costs"].sum())
    assert run_level == pytest.approx(2 * W * rate, abs=1e-15)  # first entry and last exit only
    alone = float(
        book.beta_hedged_daily([a], five, {}, betas, universe)["costs"].sum()
        + book.beta_hedged_daily([b], five, {}, betas, universe)["costs"].sum()
    )
    assert alone == pytest.approx(4 * W * rate, abs=1e-15)  # per-fold netting charges the roll in full


def test_leg_costs_slot_count_must_match():
    a = _t(entry=HOUR, exit_=5 * HOUR)
    legs = book.LegCosts.from_netted(book.netted_costs([a]), [0], 1)
    with pytest.raises(ValueError, match="slots"):
        book.beta_hedged_daily([a, a], _five_min(), {}, {s: 1.0 for s in UNIVERSE[:6]}, UNIVERSE[:6], leg_costs=legs)


def test_walk_forward_fold_costs_sum_to_the_run_level_netting():
    from r4.method import DEV_END
    from r4.pipeline import RunConfig, decision_samples, walk_forward
    from tests.test_cli_bar import BASE_CFG, _make_fast_synthetic_panel

    panel = _make_fast_synthetic_panel(symbols=UNIVERSE[:6], n_days=130, seed=22, inject_signal=True)
    raw = {**BASE_CFG, "threshold": 0.0, "features": ["ret_1"]}
    cfg = RunConfig(
        family=raw["family"],
        model=raw["model"],
        params=raw["params"],
        features=tuple(raw["features"]),
        interval=raw["interval"],
        h_ms=raw["h_ms"],
        label=raw["label"],
        side_rule=raw["side_rule"],
        threshold=raw["threshold"],
        size_rule=raw["size_rule"],
        lookback_months=raw["lookback_months"],
        refit=raw["refit"],
        exit=raw["exit"],
        seed=raw["seed"],
    )
    samples = decision_samples(panel, cfg)
    res = walk_forward(samples, cfg, first_refit_ms=raw["first_refit_ms"], end_ms=DEV_END, panel=panel)
    assert len(res.folds) >= 2 and res.excluded_tranches == 0

    # A same-side roll across a fold boundary exists, so per-fold netting would differ from run-level netting.
    fold_of = {id(t): k for k, f in enumerate(res.folds) for t in f.tranches}
    entries = {(t.symbol, t.entry_ms, t.side_val): fold_of[id(t)] for t in res.tranches}
    cross = [
        t for t in res.tranches if entries.get((t.symbol, t.exit_ms, t.side_val), fold_of[id(t)]) != fold_of[id(t)]
    ]
    assert len(cross) > 0

    run_total = float(book.netted_costs(res.tranches).by_day[["fees", "slippage"]].to_numpy().sum())
    fold_total = float(sum(f.book["costs"].sum() for f in res.folds if len(f.book)))
    assert fold_total == pytest.approx(run_total, rel=1e-12)
    separate = float(
        sum(book.netted_costs(f.tranches).by_day[["fees", "slippage"]].to_numpy().sum() for f in res.folds)
    )
    assert separate > run_total * (1 + 1e-9)
    # and the daily book of the whole run agrees day by day with the sum of the fold books
    summed = pd.concat([f.book for f in res.folds if len(f.book)]).groupby("day_start")["costs"].sum()
    whole = book.daily_book(
        res.tranches, {s: panel[s]["5m"] for s in panel}, {s: panel[s]["settlements"] for s in panel}
    )
    assert summed.reindex(whole.index).fillna(0.0).to_numpy() == pytest.approx(whole["costs"].to_numpy(), abs=1e-15)


# ---------------------------------------------------------------------------
# Finding 9: RunConfig validation
# ---------------------------------------------------------------------------


def _rc(**over):
    from r4.pipeline import RunConfig

    kw = {
        "family": "A",
        "model": "ridge",
        "params": {"alpha": 1.0},
        "features": ("ret_1",),
        "interval": "1h",
        "h_ms": 4 * HOUR,
        "label": "fixed",
        "side_rule": "sign",
        "threshold": 0.0,
        "size_rule": "unit",
        "lookback_months": None,
        "refit": "monthly",
        "exit": "horizon",
    }
    kw.update(over)
    return RunConfig(**kw)


def test_runconfig_accepts_the_registered_values():
    _rc()
    _rc(label="triple_barrier")
    _rc(model="logistic", side_rule="prob", params={"C": 1.0})
    _rc(model="lightgbm", side_rule="prob", params={})


@pytest.mark.parametrize(
    ("over", "match"),
    [
        ({"size_rule": "kelly"}, "size_rule"),
        ({"label": "triple"}, "label"),
        ({"side_rule": "prob"}, "side_rule"),
        ({"model": "logistic", "side_rule": "sign"}, "side_rule"),
        ({"model": "lightgbm", "side_rule": "sign"}, "side_rule"),
        ({"side_rule": "mystery"}, "side_rule"),
    ],
)
def test_runconfig_rejects_silent_defaults(over, match):
    with pytest.raises(ValueError, match=match):
        _rc(**over)


# ---------------------------------------------------------------------------
# Findings 3, 12, 13: counters, receipts, cell_key, SPA seed
# ---------------------------------------------------------------------------

COUNTER_KEYS = (
    "missing_model_tranches",
    "exit_model_folds",
    "exit_model_fallback_folds",
    "exit_model_fallback_tranches",
    "cpcv_missing_model",
    "cpcv_missing_sigma",
)
REPRODUCTION_KEYS = ("source_sha256", "requirements_lock_sha256", "versions")
VERSION_KEYS = ("python", "numpy", "pandas", "scipy", "scikit-learn", "lightgbm", "pyarrow")


def test_run_wf_receipt_carries_the_exit_model_counters(tmp_path: Path):
    _panel, ds_dir, cfg_file, _cfg = _small_run(tmp_path, "cnt", exit={"rule": "E3", "k": 2.0})
    receipt = run_wf(cfg_file, ds_dir, tmp_path / "out", commit="abc1234", panel=_panel)
    m = receipt["metrics"]
    for key in COUNTER_KEYS:
        assert isinstance(m[key], int) and m[key] >= 0, key
    # E3 fits no exit model: no fold fitted, none fell back, and the CPCV context holds no model to miss
    assert m["exit_model_folds"] == 0 and m["exit_model_fallback_folds"] == 0 and m["cpcv_missing_model"] == 0


def test_run_wf_receipt_maps_the_counters_one_to_one(tmp_path: Path, monkeypatch):
    import r4.cli as cli

    real = cli.walk_forward

    def patched(*args, **kwargs):
        res = real(*args, **kwargs)
        res.missing_model_tranches = 11
        res.exit_model_folds = 4
        res.exit_model_fallback_folds = 2
        res.exit_model_fallback_tranches = 37
        return res

    monkeypatch.setattr(cli, "walk_forward", patched)
    panel, ds_dir, cfg_file, _ = _small_run(tmp_path, "map", exit={"rule": "E3", "k": 2.0})
    m = run_wf(cfg_file, ds_dir, tmp_path / "out", commit="abc1234", panel=panel)["metrics"]
    assert (m["missing_model_tranches"], m["exit_model_folds"]) == (11, 4)
    assert (m["exit_model_fallback_folds"], m["exit_model_fallback_tranches"]) == (2, 37)


def test_run_wf_receipt_has_reproduction_inputs(tmp_path: Path):
    from r4.cli import source_digest

    panel, ds_dir, cfg_file, _ = _small_run(tmp_path, "repro")
    receipt = run_wf(cfg_file, ds_dir, tmp_path / "out", commit="abc1234", panel=panel)
    assert receipt["source_sha256"] == source_digest()
    lock = Path(__file__).resolve().parents[1] / "requirements.lock"
    import hashlib

    expected = hashlib.sha256(lock.read_bytes()).hexdigest() if lock.is_file() else None
    assert receipt["requirements_lock_sha256"] == expected
    assert set(receipt["versions"]) == set(VERSION_KEYS)
    assert receipt["versions"]["numpy"] == np.__version__
    assert receipt["versions"]["pandas"] == pd.__version__
    assert receipt["versions"]["python"].count(".") == 2


def test_requirements_lock_missing_is_recorded_as_null(tmp_path: Path, monkeypatch):
    from r4 import cli

    monkeypatch.setattr(cli, "REQUIREMENTS_LOCK", tmp_path / "absent.lock")
    info = cli.reproduction_inputs()
    assert info["requirements_lock_sha256"] is None
    assert "requirements_lock_sha256" in info and info["source_sha256"] == cli.source_digest()


def test_tripwire_outputs_carry_reproduction_inputs(tmp_path: Path):
    ds, cfg_file = _small_dataset(tmp_path)
    out = tmp_path / "out"
    res = run_tripwire(cfg_file, ds, out, commit="abc1234", shifts_days=[30, 37])
    on_disk = json.loads((out / "tw_run" / "tripwire.json").read_text(encoding="utf-8"))
    for doc in (res, on_disk):
        for key in REPRODUCTION_KEYS:
            assert key in doc, key
    for r in (out / "tw_run" / "tripwire").glob("*/receipt.json"):
        rec = json.loads(r.read_text(encoding="utf-8"))
        for key in REPRODUCTION_KEYS:
            assert key in rec, key
    assert _cov().shape == (6, 6)


def test_family_report_carries_reproduction_inputs_and_family_index(tmp_path: Path, monkeypatch):
    import r4.bar as bar

    ds_dir, runs_dir, panel = _write_planted_family(tmp_path)
    seen: list[int] = []
    original = bar.hansen_spa

    def recording(*args, **kwargs):
        seen.append(kwargs["seed"])
        return original(*args, **kwargs)

    monkeypatch.setattr(bar, "hansen_spa", recording)
    rep = family_report("A", runs_dir, runs_dir, 120, ds_dir, panel=panel, family_index=3)
    assert seen == [6_000_003, 6_000_003]
    assert rep["spa_seed"] == 6_000_003 and rep["family_index"] == 3
    for key in REPRODUCTION_KEYS:
        assert key in rep, key
    explicit = family_report("A", runs_dir, runs_dir, 120, ds_dir, panel=panel, family_index=3, spa_seed=99)
    assert explicit["spa_seed"] == 99 and explicit["family_index"] == 3
    default = family_report("A", runs_dir, runs_dir, 120, ds_dir, panel=panel)
    assert default["spa_seed"] == 6_000_000 and default["family_index"] == 0


def test_family_index_must_be_a_non_negative_int(tmp_path: Path):
    ds_dir, runs_dir, panel = _write_planted_family(tmp_path)
    for bad in (-1, 1.5, True):
        with pytest.raises(ValueError, match="family_index"):
            family_report("A", runs_dir, runs_dir, 120, ds_dir, panel=panel, family_index=bad)


def test_bar_cli_passes_family_index(tmp_path: Path, monkeypatch):
    import sys

    import r4.cli as cli

    seen: dict = {}
    monkeypatch.setattr(cli, "family_report", lambda **kw: seen.update(kw))
    argv = [
        "r4",
        "bar",
        "--family",
        "A",
        "--runs",
        "r",
        "--round-runs",
        "r",
        "--ledger-count",
        "120",
        "--ds",
        "d",
        "--out",
        "o",
    ]
    monkeypatch.setattr(sys, "argv", [*argv, "--family-index", "4"])
    main()
    assert seen["family_index"] == 4
    monkeypatch.setattr(sys, "argv", argv)
    main()
    assert seen["family_index"] == 0


def _mark_exit(runs_dir: Path, run_id: str, exit_cfg, **metrics) -> None:
    path = runs_dir / run_id / "receipt.json"
    rec = json.loads(path.read_text(encoding="utf-8"))
    rec["config"]["exit"] = exit_cfg
    rec["metrics"].update(metrics)
    path.write_text(json.dumps(rec), encoding="utf-8")


def test_family_report_flags_exit_model_fallback(tmp_path: Path, monkeypatch):
    import r4.bar as bar

    monkeypatch.setattr(bar, "build_exit_replay", lambda *a, **k: None)
    ds_dir, runs_dir, panel = _write_planted_family(tmp_path)
    _mark_exit(runs_dir, "cfg_0", {"rule": "E4", "margin_se": 1.0}, exit_model_folds=5, exit_model_fallback_folds=2)
    _mark_exit(runs_dir, "cfg_1", {"rule": "E4", "margin_se": 1.0}, exit_model_folds=7, exit_model_fallback_folds=0)
    rep = family_report("A", runs_dir, runs_dir, 120, ds_dir, panel=panel)
    assert rep["configurations"]["cfg_0"]["exit_model_fallback"] is True
    assert rep["configurations"]["cfg_1"]["exit_model_fallback"] is False


def test_family_report_horizon_exit_has_no_fallback_flag(tmp_path: Path):
    ds_dir, runs_dir, panel = _write_planted_family(tmp_path)
    rep = family_report("A", runs_dir, runs_dir, 120, ds_dir, panel=panel)
    assert all(c["exit_model_fallback"] is False for c in rep["configurations"].values())


def test_family_report_calibration_refuses_exit_model_fallback(tmp_path: Path, monkeypatch):
    import r4.bar as bar

    monkeypatch.setattr(bar, "build_exit_replay", lambda *a, **k: None)
    ds_dir, runs_dir, panel = _write_planted_family(tmp_path)
    for rid in ("cfg_0", "cfg_1"):
        path = runs_dir / rid / "receipt.json"
        rec = json.loads(path.read_text(encoding="utf-8"))
        rec["kind"] = "control"
        rec["config"]["joint_shift_seed"] = 11 if rid == "cfg_0" else 12
        path.write_text(json.dumps(rec), encoding="utf-8")
    e5 = {"rule": "E5", "p_close": 0.35, "confirm_bars": 3}
    _mark_exit(runs_dir, "cfg_0", e5, exit_model_fallback_folds=0)
    _mark_exit(runs_dir, "cfg_1", e5, exit_model_fallback_folds=1)
    with pytest.raises(ValueError, match="exit_model_fallback"):
        family_report("A", runs_dir, runs_dir, 120, ds_dir, panel=panel, calibration=True)


def test_cell_key_normalises_the_exit():
    base = {"interval": "1h", "h_ms": 4 * HOUR, "label": "fixed", "book": "slot"}
    one = cell_key({**base, "exit": {"rule": "E2", "k": 1}})
    one_f = cell_key({**base, "exit": {"k": 1.0, "rule": "E2"}})
    assert one == one_f
    assert cell_key({**base, "exit": {"rule": "E2", "k": 2}}) != one
    assert cell_key({**base, "exit": {"rule": "E3", "k": 1}}) != one
    assert cell_key({**base, "exit": "horizon"}) == cell_key(base)
    assert cell_key({**base, "exit": {"rule": "E5", "p_close": 0.35, "confirm_bars": 3}}) == cell_key(
        {**base, "exit": {"confirm_bars": 3, "p_close": 0.35, "rule": "E5"}}
    )


def test_stress_maker_as_taker_nets_across_folds():
    """A maker exit in one fold and a taker entry at the same open in the next net once relabelled."""
    from r4.cli import stress_metrics
    from r4.pipeline import FoldRecord

    a = _t(entry=1 * HOUR, exit_=5 * HOUR, exit_fill="maker")
    b = _t(entry=5 * HOUR, exit_=9 * HOUR)
    betas = {s: 1.0 for s in UNIVERSE}
    empty = pd.DataFrame()
    folds = [
        FoldRecord(DAY0, DAY0 + 5 * HOUR, None, betas, [a], empty),
        FoldRecord(DAY0 + 5 * HOUR, DAY0 + DAY_MS, None, betas, [b], empty),
    ]
    idx = pd.Index([DAY0], name="day_start")
    drift = pd.DataFrame({"drift_free": [0.01]}, index=idx)
    out = stress_metrics(folds, drift, DAY0, DAY0 + DAY_MS)
    rate = TAKER + BTC_SLIP
    maker = 0.0002
    extra = -W * (maker + rate)  # the roll's maker exit and taker entry net to zero, saving both legs
    assert out["stress_maker_as_taker"] == pytest.approx(0.01 - extra, abs=1e-15)
