"""Brief 38: the family C holdout module r4.holdout_c (A11.2). Synthetic data only, nothing reads D or H."""

from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pytest

from r4 import causality, cli, data, family_c, holdout_c, method
from r4 import holdout_c as hc
from r4.synth import synth_panel

H = 3_600_000
DAY = 86_400_000
BAR = 300_000
COINS3 = ("BTCUSDT", "ETHUSDT", "SOLUSDT")
GOOD_VERSIONS = dict(hc.VERSIONS)


def _noise(panel: dict[str, dict[str, pd.DataFrame]], seed: int = 3) -> None:
    """A9.1's convention: premium N(0.0001, 0.00005), funding N(0.0001, 0.00002) at 00, 08 and 16 UTC."""
    rng = np.random.default_rng(seed)
    for s in panel:
        p = panel[s]["premium_5m"].copy()
        p["c"] = rng.normal(0.0001, 0.00005, size=len(p))
        f = panel[s]["settlements"].copy()
        f["rate"] = rng.normal(0.0001, 0.00002, size=len(f))
        panel[s]["premium_5m"] = panel[s]["premiumIndex"] = p
        panel[s]["settlements"] = panel[s]["funding"] = f


def _panel(coins: tuple[str, ...], start: int, days: int, seed: int = 11) -> dict[str, dict[str, pd.DataFrame]]:
    k = len(coins)
    cov = 0.0009 * (0.5 * np.eye(k) + 0.5 * np.ones((k, k)))
    panel = synth_panel(cov, list(coins), start, start + days * DAY, seed)
    _noise(panel, seed + 1)
    return panel


START = method.DEV_END - 200 * DAY
END = method.DEV_END


@pytest.fixture(scope="module")
def small() -> dict[str, Any]:
    """Three coins over 200 days, a monthly-refit config with lookback 1 month and 300 minimum windows."""
    panel = _panel(COINS3, START, 200)
    first = START + 60 * DAY
    config = dict(
        family_c.family_c()[hc.REGISTRY_INDEX], first_refit_ms=first, min_train_windows=300, lookback_months=1
    )
    prep = family_c.prepare_window(panel, "1h", END)
    refits = family_c.refit_times(first, END)
    return {"panel": panel, "config": config, "prep": prep, "refits": refits, "first": first}


@pytest.fixture
def fits_small(small: dict[str, Any]) -> dict[str, dict[str, Any]]:
    final = hc.final_model(small["prep"], cutoff_ms=small["refits"][1], lookback_months=1, min_train=300, coins=COINS3)
    return hc.parse_model(json.loads(hc.canonical_bytes(hc.model_object(final))), coins=COINS3)


# ---------------------------------------------------------------------------------------------------------------------
# 1 constants, 2 pins
# ---------------------------------------------------------------------------------------------------------------------


def test_01_constants() -> None:
    assert hc.CUTOFF_MS == 1_780_272_000_000 == method.DEV_END - 30 * DAY
    assert hc.LOOKBACK_START_MS == 1_717_200_000_000 and hc.LOOKBACK_MONTHS == 24 and hc.MIN_TRAIN == 500
    assert hc.EARLIEST_INPUT_MS > method.DEV_START
    assert hc.EARLIEST_INPUT_MS == hc.LOOKBACK_START_MS - 30 * DAY - H - family_c.FUND_MAX_AGE_MS
    assert hc.H_SEED == 12_200_002 and hc.H_SEED_INDEX_ARG == 100_002
    assert hc.WINDOW == "1h" and hc.WINDOW_MS == H and hc.REGISTRY_INDEX == 2
    for fid in (hc.FINALIST_ID, hc.REHEARSAL_FINALIST_ID):
        assert data._FINALIST_ID_RE.fullmatch(fid)
    assert hc.FINALIST_ID == "c-lhar-x-1h" and hc.REHEARSAL_FINALIST_ID == "c-lhar-x-1h-rehearsal"
    entry = family_c.family_c()[hc.REGISTRY_INDEX]
    assert entry["id"] == hc.FINALIST_CONFIG_ID == "C_LHAR-X_1h"
    assert cli.config_hash_of(entry) == hc.CONFIG_HASH
    assert hc.D_DATASET_HASH == "11c87b9c8a97c367b6cd7c0c983f4d2bd9e940f62856a85c6e76537ac18a9a62"
    assert hc.REFERENCE_FORECASTS_SHA256.startswith("696c5ef1") and hc.REFERENCE_FINITE_F_ROWS == 276_840
    assert hc.REFERENCE_FINITE_F_DIGEST.startswith("a6ed91ee")
    assert (hc.D_DIR, hc.H_DIR, hc.LEDGER_PATH, hc.REF_PATH, hc.OUT_DIR) == (
        "/ds",
        "/h",
        "/ledger/holdout-reads.jsonl",
        "/ref/forecasts.parquet",
        "/out",
    )
    assert (hc.REHEARSAL_H_DIR, hc.REHEARSAL_LEDGER_PATH) == ("/rh", "/scratch/ledger.jsonl")
    assert hc.LEDGER_KEYS == ("at", "finalist_id", "path", "read_id")
    assert hc.ARTIFACT_KIND == "round4-family-c-final-model"
    assert hc.SPEC.cutoff_ms == hc.CUTOFF_MS and hc.SPEC.symbols_min is None and hc.SPEC.h_seed == hc.H_SEED
    assert hc.SPEC.h_seed_index_arg == hc.H_SEED_INDEX_ARG and hc.SPEC.lookback_months == 24
    assert hc.SPEC.coins == method.UNIVERSE and hc.SPEC.config["id"] == "C_LHAR-X_1h"
    assert family_c.run_holdout.__name__ == "run_holdout"


def _good_repro() -> dict[str, Any]:
    return {
        "source_sha256": cli.source_digest(),
        "requirements_lock_sha256": hc.REQUIREMENTS_LOCK_SHA256,
        "versions": dict(GOOD_VERSIONS),
    }


def test_02_file_pins_and_versions(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, want in hc.FROZEN_FILES_SHA256.items():
        assert hashlib.sha256((Path(hc.__file__).parent / name).read_bytes()).hexdigest() == want
    monkeypatch.setattr(cli, "reproduction_inputs", _good_repro)
    out = hc.check_code(None)
    assert out["reproduction_inputs"]["versions"] == GOOD_VERSIONS
    bindings = {
        "source_sha256": cli.source_digest(),
        "holdout_c_sha256": hashlib.sha256(Path(hc.__file__).read_bytes()).hexdigest(),
    }
    hc.check_code(bindings)
    with pytest.raises(ValueError, match="source digest"):
        hc.check_code({**bindings, "source_sha256": "0" * 64})
    with pytest.raises(ValueError, match="holdout_c_sha256"):
        hc.check_code({**bindings, "holdout_c_sha256": "0" * 64})
    real = hc._read_bytes
    monkeypatch.setattr(hc, "_read_bytes", lambda p: b"x" if str(p).endswith("family_c.py") else real(p))
    with pytest.raises(ValueError, match="family_c.py"):
        hc.check_code(None)
    monkeypatch.setattr(hc, "_read_bytes", real)
    monkeypatch.setattr(
        cli, "reproduction_inputs", lambda: {**_good_repro(), "versions": {**GOOD_VERSIONS, "python": "3.13.7"}}
    )
    with pytest.raises(ValueError, match="library versions"):
        hc.check_code(None)
    monkeypatch.setattr(cli, "reproduction_inputs", lambda: {**_good_repro(), "requirements_lock_sha256": "0" * 64})
    with pytest.raises(ValueError, match="requirements.lock"):
        hc.check_code(None)


# ---------------------------------------------------------------------------------------------------------------------
# 3 the final model equals the walk-forward fold, 4 strict t1, 5 round trip, 6 columns, 7 batch rule, 8 causality
# ---------------------------------------------------------------------------------------------------------------------


def test_03_final_model_equals_the_walk_forward_fold(small: dict[str, Any]) -> None:
    refits = small["refits"]
    assert len(refits) >= 3
    ref, _ = family_c.compute_forecasts(small["panel"], small["config"], small["prep"])
    for k in (1, 2):
        cutoff, nxt = refits[k], (refits[k + 1] if k + 1 < len(refits) else END)
        final = hc.final_model(small["prep"], cutoff_ms=cutoff, lookback_months=1, min_train=300, coins=COINS3)
        fits = hc.parse_model(json.loads(hc.canonical_bytes(hc.model_object(final))), coins=COINS3)
        frame, _ = hc.forecast_frame(small["prep"], fits, cutoff, nxt, coins=COINS3, fold_ms=cutoff)
        want = ref.loc[ref["fold"] == cutoff]
        assert len(want) > 100
        d = hc._diff(hc._sorted_rows(frame), hc._sorted_rows(want), coin_values=True)
        assert d["equal"], d
        assert list(frame.columns) == family_c.FORECAST_COLUMNS
        assert frame["fold"].dtype == np.int64 and frame["T"].dtype == np.int64
        pd.testing.assert_frame_equal(
            hc._sorted_rows(frame), hc._sorted_rows(want), check_exact=True, check_dtype=False
        )


def test_04_strict_t1(small: dict[str, Any]) -> None:
    cutoff = small["refits"][2]
    kw: dict[str, Any] = {"lookback_months": 24, "min_train": 300, "coins": ("BTCUSDT",)}
    a = hc.final_model(small["prep"], cutoff_ms=cutoff, **kw)["BTCUSDT"]
    b = hc.final_model(small["prep"], cutoff_ms=cutoff + H, **kw)["BTCUSDT"]
    x = family_c.design(small["prep"]["BTCUSDT"]["comp"], small["prep"]["BTCUSDT"]["exog"], "LHAR-X", "1h", True)
    rv = small["prep"]["BTCUSDT"]["win"]["RV"]
    old = hc.training_mask(x, rv, H, cutoff, 24)
    new = hc.training_mask(x, rv, H, cutoff + H, 24)
    T = x.index.to_numpy()
    at_cutoff = np.isfinite(x.to_numpy()).all(axis=1) & np.isfinite(rv.reindex(x.index).to_numpy()) & (T + H == cutoff)
    assert at_cutoff.sum() == 1
    assert not (old & at_cutoff).any() and (new & at_cutoff).sum() == 1
    assert b["fit"]["n_train"] - a["fit"]["n_train"] == int(at_cutoff.sum())
    assert a["train_t1_max_ms"] < cutoff and b["train_t1_max_ms"] == cutoff
    assert a["mask_count"] == a["fit"]["n_train"]


def test_05_artifact_round_trip(small: dict[str, Any]) -> None:
    final = hc.final_model(small["prep"], cutoff_ms=small["refits"][1], lookback_months=1, min_train=300, coins=COINS3)
    model = hc.model_object(final)
    raw = hc.canonical_bytes(model)
    assert raw == hc.canonical_bytes(model) and raw.isascii() and not raw.endswith(b"\n")
    back = json.loads(raw)
    for c in COINS3:
        assert np.array_equal(np.asarray(back[c]["beta"]).view(np.uint64), final[c]["fit"]["beta"].view(np.uint64))
        assert back[c]["s2"] == final[c]["fit"]["s2"] and back[c]["q"] == final[c]["fit"]["q"]
    assert hashlib.sha256(raw).hexdigest() == hashlib.sha256(hc.canonical_bytes(back)).hexdigest()
    assert hc.canonical_bytes({"a": np.float64(1.5), "b": np.int64(2), "c": np.array([1.0, 2.0])}) == (
        b'{"a":1.5,"b":2,"c":[1.0,2.0]}'
    )
    with pytest.raises(ValueError):
        hc.canonical_bytes({"x": float("nan")})
    parsed = hc.parse_model(back, coins=COINS3)
    assert all(isinstance(parsed[c]["beta"], np.ndarray) and parsed[c]["beta"].dtype == np.float64 for c in COINS3)
    missing = {k: v for k, v in back.items() if k != "SOLUSDT"}
    with pytest.raises(ValueError, match="SOLUSDT"):
        hc.parse_model(missing, coins=COINS3)
    short = json.loads(raw)
    short["ETHUSDT"]["beta"] = short["ETHUSDT"]["beta"][:-1]
    with pytest.raises(ValueError, match="coefficients"):
        hc.parse_model(short, coins=COINS3)
    bad = json.loads(raw)
    bad["BTCUSDT"]["beta"][0] = float("inf")
    with pytest.raises(ValueError, match="finite"):
        hc.parse_model(bad, coins=COINS3)


def test_06_columns(small: dict[str, Any], fits_small: dict[str, dict[str, Any]]) -> None:
    cols = hc.expected_columns()
    assert len(cols["BTCUSDT"]) == 7 and all(len(v) == 8 for c, v in cols.items() if c != "BTCUSDT")
    assert cols["BTCUSDT"] == ["const", "lrv_prev", "lrv_1d", "lrv_7d", "lrv_30d", "abs_fund", "abs_prem"]
    assert set(cols) == set(method.UNIVERSE)
    for c in COINS3:
        assert fits_small[c]["columns"] == cols[c]
    broken = {c: dict(f) for c, f in fits_small.items()}
    broken["ETHUSDT"]["columns"] = [*cols["ETHUSDT"][:-1], "other"]
    with pytest.raises(ValueError, match="ETHUSDT"):
        hc.forecast_frame(small["prep"], broken, small["refits"][1], END, coins=COINS3)


def test_07_batch_rule(
    small: dict[str, Any], fits_small: dict[str, dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[int] = []
    real = family_c.apply_fit

    def spy(fit: dict[str, Any], x: pd.DataFrame) -> np.ndarray:
        calls.append(len(x))
        return real(fit, x)

    monkeypatch.setattr(family_c, "apply_fit", spy)
    frame, _ = hc.forecast_frame(small["prep"], fits_small, small["refits"][1], END, coins=COINS3)
    assert len(calls) == 3 and sum(calls) == len(frame)


def test_08_causality(small: dict[str, Any], fits_small: dict[str, dict[str, Any]]) -> None:
    panel = small["panel"]
    eth = "ETHUSDT"
    T0 = small["refits"][1] + 20 * DAY
    T0 -= T0 % H
    Ts = [T0, T0 + H, T0 + 2 * H]
    orig = {
        "k": panel[eth]["5m"],
        "p": panel[eth]["premium_5m"],
        "s": panel[eth]["settlements"],
        "b": panel["BTCUSDT"]["5m"],
    }

    def pin(frame: pd.DataFrame, source: pd.DataFrame) -> pd.DataFrame:
        """The target windows [T, T + 1h) are held fixed, so only the inputs after them and before them can move f."""
        inside = ((frame["t"] // H) * H).isin(Ts)
        src_inside = ((source["t"] // H) * H).isin(Ts)
        return pd.concat([frame[~inside], source[src_inside]]).sort_values("t").reset_index(drop=True)

    def build(k: pd.DataFrame, p: pd.DataFrame, s: pd.DataFrame, b: pd.DataFrame) -> pd.DataFrame:
        sub = {
            "BTCUSDT": {"5m": pin(b, orig["b"]), "settlements": None, "premium_5m": None},
            eth: {"5m": pin(k, orig["k"]), "settlements": s, "premium_5m": p},
        }
        btc_wt = hc.prepare_btc(sub, END)
        prep = {eth: hc.prepare_coin(sub, eth, btc_wt, END)}
        frame, _ = hc.forecast_frame(prep, fits_small, Ts[0], Ts[-1] + H, coins=(eth,))
        return frame.set_index("T")[["f"]]

    causality.assert_future_invariant(
        build,
        {"k": (orig["k"], BAR), "p": (orig["p"], BAR), "s": (orig["s"], 0), "b": (orig["b"], BAR)},
        Ts,
    )


# ---------------------------------------------------------------------------------------------------------------------
# 24 per-coin preparation equals prepare_window, bitwise comparison
# ---------------------------------------------------------------------------------------------------------------------


def _copy_panel(panel: dict[str, dict[str, pd.DataFrame]]) -> dict[str, dict[str, pd.DataFrame]]:
    return {s: {k: (v.copy() if isinstance(v, pd.DataFrame) else v) for k, v in d.items()} for s, d in panel.items()}


def _prep_cases() -> dict[str, tuple[dict[str, dict[str, pd.DataFrame]], int]]:
    start = END - 30 * DAY
    base = _panel(COINS3, start, 30, seed=21)
    cases: dict[str, tuple[dict[str, dict[str, pd.DataFrame]], int]] = {"plain": (base, END)}
    zero = _copy_panel(base)
    k = zero["ETHUSDT"]["5m"]
    k.loc[k["t"] == start + 10 * DAY + 3 * H + 2 * BAR, "v"] = 0.0
    cases["zero volume"] = (zero, END)
    nofund = _copy_panel(base)
    nofund["SOLUSDT"]["settlements"] = nofund["SOLUSDT"]["settlements"].iloc[0:0]
    cases["empty funding"] = (nofund, END)
    messy = _copy_panel(base)
    k = messy["ETHUSDT"]["5m"]
    k = pd.concat([k, k.iloc[100:130]]).sample(frac=1.0, random_state=1).reset_index(drop=True)
    k.loc[5, "t"] += 7
    messy["ETHUSDT"]["5m"] = k
    cases["unsorted duplicates off grid"] = (messy, END)
    late = _copy_panel(base)
    late["SOLUSDT"]["5m"] = late["SOLUSDT"]["5m"][lambda f: f["t"] >= start + 17 * DAY + 5 * BAR].reset_index(drop=True)
    cases["late listing"] = (late, END)
    nobtc = _copy_panel(base)
    nobtc["BTCUSDT"]["5m"] = nobtc["BTCUSDT"]["5m"].iloc[:6].reset_index(drop=True)
    cases["btc without a complete window"] = (nobtc, END)
    rev = {s: base[s] for s in reversed(list(base))}
    cases["reversed key order"] = (rev, END)
    cases["early partition end"] = (base, start + 20 * DAY)
    return cases


@pytest.mark.parametrize("name", list(_prep_cases()))
def test_24_per_coin_preparation_equals_prepare_window(name: str) -> None:
    panel, end = _prep_cases()[name]
    ref = family_c.prepare_window(panel, "1h", end)
    btc_wt = hc.prepare_btc(panel, end)
    for c in panel:
        mine = hc.prepare_coin(panel, c, btc_wt, end)
        assert set(mine) == set(ref[c]) == {"win", "info", "comp", "exog", "persistence", "ewma"}
        for key in ("win", "comp", "exog", "persistence", "ewma"):
            d = hc._diff(mine[key], ref[c][key])
            assert d["equal"], (name, c, key, d)
        assert mine["info"] == ref[c]["info"]


def test_24_an_empty_5m_frame_raises_keyerror_in_both() -> None:
    panel = _copy_panel(_prep_cases()["plain"][0])
    panel["SOLUSDT"]["5m"] = panel["SOLUSDT"]["5m"].iloc[0:0]
    with pytest.raises(KeyError):
        family_c.prepare_window(panel, "1h", END)
    btc_wt = hc.prepare_btc(panel, END)
    with pytest.raises(KeyError):
        hc.prepare_coin(panel, "SOLUSDT", btc_wt, END)
    hc.prepare_coin(panel, "ETHUSDT", btc_wt, END)


def test_diff_is_bitwise_and_strict() -> None:
    a = pd.DataFrame({"x": [0.0, 1.0, np.nan]}, index=pd.Index([1, 2, 3], name="T"))
    assert hc._diff(a, a.copy())["equal"]
    neg = a.copy()
    neg.loc[1, "x"] = -0.0
    pd.testing.assert_frame_equal(a, neg, check_exact=True)
    assert not hc._diff(a, neg)["equal"]
    ulp = a.copy()
    ulp.loc[2, "x"] = np.nextafter(1.0, 2.0)
    d = hc._diff(a, ulp)
    assert not d["equal"] and d["n_rows_differ"] == 1 and 0.0 < d["max_rel"] < 1e-15
    assert not hc._diff(a, a.rename_axis("U"))["equal"]
    assert not hc._diff(a, a.rename(columns={"x": "y"}))["equal"]
    assert not hc._diff(a, a.astype({"x": "float32"}))["equal"]
    assert not hc._diff(a, a.iloc[:2])["equal"]
    assert hc._diff(a["x"], a["x"].copy())["equal"] and not hc._diff(a["x"], a["x"].rename("z"))["equal"]


# ---------------------------------------------------------------------------------------------------------------------
# bind_d: B1 to B4 on a small D
# ---------------------------------------------------------------------------------------------------------------------


def _spec_for(small: dict[str, Any], ref: pd.DataFrame, **kw: Any) -> hc.Spec:
    from r4 import family_d

    finite = ref.loc[np.isfinite(ref["f"].to_numpy())]
    base: dict[str, Any] = {
        "coins": COINS3,
        "dev_start": START,
        "dev_end": END,
        "cutoff_ms": small["refits"][-1],
        "lookback_months": 1,
        "min_train": 300,
        "config": small["config"],
        "reference_finite_digest": family_d.canonical_digest(finite, "f"),
        "reference_finite_rows": len(finite),
    }
    return hc.Spec(**{**base, **kw})


@pytest.fixture(scope="module")
def bound(small: dict[str, Any]) -> dict[str, Any]:
    ref, _ = family_c.compute_forecasts(small["panel"], small["config"], small["prep"])
    spec = _spec_for(small, ref)
    final = hc.final_model(small["prep"], cutoff_ms=spec.cutoff_ms, lookback_months=1, min_train=300, coins=COINS3)
    fits = hc.parse_model(json.loads(hc.canonical_bytes(hc.model_object(final))), coins=COINS3)
    return {"ref": ref, "spec": spec, "final": final, "fits": fits}


def test_bind_d_passes_and_records_all_four(small: dict[str, Any], bound: dict[str, Any]) -> None:
    out = hc.bind_d(
        small["panel"], small["prep"], bound["ref"], bound["fits"], spec=bound["spec"], final=bound["final"]
    )
    assert out["B1"]["equal"] and out["B1"]["finite_f_rows"] == bound["spec"].reference_finite_rows
    assert out["B2"]["equal"] and out["B2"]["rows"] > 100
    assert set(out["B3"]["n_train"]) == set(COINS3)
    assert out["B4"] == dict.fromkeys(COINS3, True)
    light = hc.bind_d(small["panel"], small["prep"], bound["ref"], bound["fits"], spec=bound["spec"], full=False)
    assert set(light) == {"B2", "B4"}


def test_bind_d_refuses_each_mismatch(small: dict[str, Any], bound: dict[str, Any]) -> None:
    ref = bound["ref"].copy()
    spec = bound["spec"]
    idx = int(np.flatnonzero((ref["fold"] == spec.cutoff_ms).to_numpy() & np.isfinite(ref["f"].to_numpy()))[3])
    ref.loc[idx, "f"] = np.nextafter(ref.loc[idx, "f"], np.inf)
    with pytest.raises(ValueError, match=r"B1 .*1 differing rows"):
        hc.bind_d(small["panel"], small["prep"], ref, bound["fits"], spec=spec)
    with pytest.raises(ValueError, match="B2"):
        hc.bind_d(small["panel"], small["prep"], ref, bound["fits"], spec=spec, full=False)
    other = bound["spec"].__class__(**{**spec.__dict__, "reference_finite_rows": spec.reference_finite_rows + 1})
    with pytest.raises(ValueError, match="digest"):
        hc.bind_d(small["panel"], small["prep"], bound["ref"], bound["fits"], spec=other)
    prep = {c: dict(p) for c, p in small["prep"].items()}
    comp = prep["ETHUSDT"]["comp"].copy()
    comp.iloc[40, 0] = np.nextafter(comp.iloc[40, 0], np.inf)
    prep["ETHUSDT"]["comp"] = comp
    with pytest.raises(ValueError, match=r"B4 \(ETHUSDT, comp\)"):
        hc.bind_d(small["panel"], prep, bound["ref"], bound["fits"], spec=spec, full=False)
    fits = {c: dict(f) for c, f in bound["fits"].items()}
    fits["SOLUSDT"]["s2"] = fits["SOLUSDT"]["s2"] * 1.000001
    with pytest.raises(ValueError, match="B2"):
        hc.bind_d(small["panel"], small["prep"], bound["ref"], fits, spec=spec, full=False)


# ---------------------------------------------------------------------------------------------------------------------
# 9 to 12, 25: the gated evaluation
# ---------------------------------------------------------------------------------------------------------------------


def _ok_records(coins: tuple[str, ...]) -> list[dict[str, Any]]:
    return hc._matching_records(coins)


def _eval_spec(small: dict[str, Any], **kw: Any) -> hc.Spec:
    return hc.Spec(
        coins=COINS3,
        h_start=START,
        h_end=END,
        cutoff_ms=small["refits"][1],
        lookback_months=1,
        min_train=300,
        symbols_min=2,
        **kw,
    )


def _evaluate(small: dict[str, Any], fits: dict[str, dict[str, Any]], panel: Any = None, **kw: Any) -> Any:
    return hc.evaluate_gated(
        panel if panel is not None else small["panel"], fits, _ok_records(COINS3), spec=_eval_spec(small, **kw)
    )


def test_09_empty_inputs(small: dict[str, Any], fits_small: dict[str, dict[str, Any]]) -> None:
    gappy = _copy_panel(small["panel"])
    for c in gappy:
        k = gappy[c]["5m"]
        gappy[c]["5m"] = k[(k["t"] % H) != 2 * BAR].reset_index(drop=True)
    prep = family_c.prepare_window(gappy, "1h", END)
    frame, info = hc.forecast_frame(prep, fits_small, START, END, coins=COINS3)
    assert len(frame) == 0 and list(frame.columns) == family_c.FORECAST_COLUMNS
    assert set(info["skipped"]) == set(COINS3)
    rec, pooled, _ = _evaluate(small, fits_small, gappy)
    assert rec["errors"] == [] and rec["h_pass"] is False and rec["verdict"]["n_coins_pass"] == 0
    assert pooled is not None and len(pooled) == 0
    # one coin with an empty window table is skipped, the others are built
    prep2 = family_c.prepare_window(small["panel"], "1h", END)
    empty_win = family_c.window_table(small["panel"]["SOLUSDT"]["5m"].iloc[0:0], H, END)[0]
    prep2["SOLUSDT"] = {"win": empty_win}
    frame2, info2 = hc.forecast_frame(prep2, fits_small, START, END, coins=COINS3)
    assert info2["skipped"] == {"SOLUSDT": "no window table"} and set(frame2["coin"]) == {"BTCUSDT", "ETHUSDT"}
    panel3 = _copy_panel(small["panel"])
    panel3["SOLUSDT"]["5m"] = panel3["SOLUSDT"]["5m"].iloc[0:0]
    rec3, _, _ = _evaluate(small, fits_small, panel3)
    assert [(e["coin"], e["stage"]) for e in rec3["errors"]] == [("SOLUSDT", "preparation")]
    assert "KeyError" in rec3["errors"][0]["error"]
    assert rec3["stay_out"]["reason"] == "forecasts undefined" and rec3["h_pass"] is False


def test_10_stay_out_seed(
    small: dict[str, Any], fits_small: dict[str, dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    rec, pooled, _ = _evaluate(small, fits_small)
    assert pooled is not None
    want = family_c.stay_out_flag(pooled, 3_600_000, 100_002)
    assert rec["stay_out"]["flag1"] == want["flag1"] and rec["stay_out"]["flag2"] == want["flag2"]
    assert rec["stay_out"]["pass"] is want["pass"] and rec["stay_out"]["error"] is None
    assert rec["stay_out"]["flag1"]["seed"] == 12_200_002 and "low" in rec["stay_out"]["flag1"]
    other = family_c.stay_out_flag(pooled, 3_600_000, 2)
    assert other["flag1"]["seed"] == 12_100_002 and other["flag1"]["low"] != want["flag1"]["low"]
    assert hc.seed_precheck()["seed"] == 12_200_002
    with pytest.raises(ValueError, match="seed"):
        hc.seed_precheck(spec=hc.Spec(h_seed_index_arg=100_003))


def _fake_env(
    monkeypatch: pytest.MonkeyPatch, passing: set[str], raising: set[str] = frozenset(), stay_pass: bool = True
) -> None:  # type: ignore[assignment]
    """Ten coins, a patched forecast builder and criteria: only evaluate_gated's own verdict logic runs."""
    state = {"coin": ""}

    def fake_frame(prep: Any, fits: Any, lo: int, hi: int, **kw: Any) -> tuple[pd.DataFrame, dict[str, Any]]:
        (state["coin"],) = kw["coins"]
        return hc._empty_forecasts(), {}

    def fake_criteria(df: Any, window_ms: int) -> dict[str, Any]:
        if state["coin"] in raising:
            raise RuntimeError("boom")
        return {"pass": state["coin"] in passing, "mean_qlike": 0.1}

    monkeypatch.setattr(hc, "forecast_frame", fake_frame)
    monkeypatch.setattr(family_c, "coin_criteria", fake_criteria)
    flag2 = {"pass": stay_pass}
    monkeypatch.setattr(
        family_c,
        "stay_out_flag",
        lambda rows, w, i: {"flag1": {"pass": True, "seed": 12_200_002}, "flag2": flag2, "pass": stay_pass},
    )


@pytest.fixture(scope="module")
def panel10() -> dict[str, dict[str, pd.DataFrame]]:
    return _panel(method.UNIVERSE, END - 35 * DAY, 35, seed=5)


def test_11_verdict(panel10: dict[str, dict[str, pd.DataFrame]], monkeypatch: pytest.MonkeyPatch) -> None:
    coins = method.UNIVERSE
    spec = hc.Spec(h_start=END - 35 * DAY, h_end=END)
    _fake_env(monkeypatch, set(coins[:8]))
    rec, _, _ = hc.evaluate_gated(panel10, {}, _ok_records(coins), spec=spec)
    assert rec["verdict"]["n_coins_pass"] == 8 and rec["verdict"]["symbols_min"] == 8 and rec["h_pass"] is True
    assert "inconclusive" not in json.dumps(to_j(rec)).lower() and "power" not in json.dumps(to_j(rec)).lower()
    _fake_env(monkeypatch, set(coins[:7]))
    rec, _, _ = hc.evaluate_gated(panel10, {}, _ok_records(coins), spec=spec)
    assert rec["verdict"]["n_coins_pass"] == 7 and rec["h_pass"] is False
    _fake_env(monkeypatch, set(coins[:7]), raising={coins[7]})  # a missing coin counts as a fail
    rec, _, _ = hc.evaluate_gated(panel10, {}, _ok_records(coins), spec=spec)
    assert rec["verdict"]["n_coins_pass"] == 7 and rec["h_pass"] is False
    assert [(e["coin"], e["stage"]) for e in rec["errors"]] == [(coins[7], "criteria")]
    _fake_env(monkeypatch, set(coins[:8]), stay_pass=False)  # condition 2 with no flagged window
    rec, _, _ = hc.evaluate_gated(panel10, {}, _ok_records(coins), spec=spec)
    assert rec["verdict"]["pass"] is True and rec["stay_out"]["pass"] is False and rec["h_pass"] is False


def to_j(obj: Any) -> Any:
    return hc.to_jsonable(obj)


def test_12_exception_rule(
    small: dict[str, Any], fits_small: dict[str, dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    base, base_pool, _ = _evaluate(small, fits_small)
    assert base["errors"] == [] and set(base["per_coin"]) == set(COINS3)
    # criteria raise for one coin: it fails, the others are evaluated, its rows stay in the flag's input
    real = family_c.coin_criteria
    seen: list[int] = []

    def crit(df: pd.DataFrame, w: int) -> dict[str, Any]:
        if (df["coin"] == "ETHUSDT").any():
            raise RuntimeError("criteria boom")
        seen.append(len(df))
        return real(df, w)

    monkeypatch.setattr(family_c, "coin_criteria", crit)
    rec, pool, _ = _evaluate(small, fits_small)
    assert [(e["coin"], e["stage"]) for e in rec["errors"]] == [("ETHUSDT", "criteria")]
    assert set(rec["per_coin"]) == {"BTCUSDT", "SOLUSDT"} and len(seen) == 2
    assert rec["forecasts_undefined"] == [] and rec["stay_out"]["reason"] is None
    assert pool is not None and base_pool is not None and len(pool) == len(base_pool)
    assert (
        rec["stay_out"]["flag1"] == base["stay_out"]["flag1"] and rec["stay_out"]["flag2"] == base["stay_out"]["flag2"]
    )
    monkeypatch.setattr(family_c, "coin_criteria", real)
    # the flag raises: it fails and the verdict line can still be built
    monkeypatch.setattr(family_c, "stay_out_flag", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("flag boom")))
    rec, _, _ = _evaluate(small, fits_small)
    assert rec["stay_out"]["pass"] is False and "flag boom" in rec["stay_out"]["error"] and rec["h_pass"] is False
    assert rec["stay_out"]["flag1_pass"] is False and rec["stay_out"]["flag2_pass"] is False
    assert [e["stage"] for e in rec["errors"]] == ["stay-out flag"]


def test_12_a_forecast_exception_fails_the_coin_and_the_flag(
    small: dict[str, Any], fits_small: dict[str, dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    real = hc.forecast_frame

    def ff(prep: Any, fits: Any, lo: int, hi: int, **kw: Any) -> Any:
        assert kw["coins"] == tuple(prep) and len(kw["coins"]) == 1
        if kw["coins"] == ("ETHUSDT",):
            raise RuntimeError("forecast boom")
        return real(prep, fits, lo, hi, **kw)

    monkeypatch.setattr(hc, "forecast_frame", ff)
    rec, pool, _ = _evaluate(small, fits_small)
    assert [(e["coin"], e["stage"]) for e in rec["errors"]] == [("ETHUSDT", "forecasts")]
    assert "ETHUSDT" not in rec["per_coin"] and set(rec["per_coin"]) == {"BTCUSDT", "SOLUSDT"}
    assert rec["stay_out"]["reason"] == "forecasts undefined" and rec["stay_out"]["coins"] == ["ETHUSDT"]
    assert rec["stay_out"]["pass"] is False and rec["stay_out"]["flag1_pass"] is False and rec["h_pass"] is False
    assert rec["stay_out_descriptive"] is not None
    assert pool is not None and set(pool["coin"]) == {"BTCUSDT", "SOLUSDT"}
    # the computed result on the remaining rows would have passed condition 2 (the point of failing the flag)
    assert rec["stay_out_descriptive"]["flag2"] == family_c.stay_out_flag(pool, 3_600_000, 100_002)["flag2"]


def test_25_isolation_and_btc(
    small: dict[str, Any], fits_small: dict[str, dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    real_exog = family_c.exog_frame
    calls: list[int] = []

    def exog(T: Any, w: int, s: Any, p: Any, b: Any) -> Any:
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError("exog boom")
        return real_exog(T, w, s, p, b)

    monkeypatch.setattr(family_c, "exog_frame", exog)
    rec, _, _ = _evaluate(small, fits_small)
    assert [(e["coin"], e["stage"]) for e in rec["errors"]] == [("ETHUSDT", "preparation")]
    assert set(rec["per_coin"]) == {"BTCUSDT", "SOLUSDT"} and rec["stay_out"]["reason"] == "forecasts undefined"
    monkeypatch.setattr(family_c, "exog_frame", real_exog)
    real_wt = family_c.window_table
    btc_frame = small["panel"]["BTCUSDT"]["5m"]

    def wt(bars: pd.DataFrame, w: int, end: int | None = None) -> Any:
        if bars is btc_frame:
            raise RuntimeError("window boom")
        return real_wt(bars, w, end)

    monkeypatch.setattr(family_c, "window_table", wt)
    rec, pool, _ = _evaluate(small, fits_small)
    assert [(e["coin"], e["stage"]) for e in rec["errors"]] == [(c, "btc window table") for c in COINS3]
    assert rec["per_coin"] == {} and rec["forecasts_undefined"] == list(COINS3)
    assert rec["stay_out"]["pass"] is False and rec["h_pass"] is False


# ---------------------------------------------------------------------------------------------------------------------
# 15 to_jsonable, 17 and 18 ledger and containment
# ---------------------------------------------------------------------------------------------------------------------


def test_15_to_jsonable() -> None:
    obj = {
        np.int64(3): np.array([1.0, np.nan, np.inf]),
        "a": {1: pd.Timestamp("2020-01-01", tz="UTC"), "b": np.int64(4), "c": (np.float64(2.5), float("nan"))},
        7: [np.bool_(True), None, "x", object()],
        "df": pd.DataFrame({"x": [1, 2]}),
        "ser": pd.Series([1.5, 2.5]),
    }
    out = hc.to_jsonable(obj)
    text = json.dumps(out, sort_keys=True, allow_nan=False)
    back = json.loads(text)
    assert back["3"] == [1.0, None, None] and back["a"]["1"].startswith("2020-01-01") and back["a"]["b"] == 4
    assert back["a"]["c"] == [2.5, None] and back["7"][:3] == [True, None, "x"] and back["7"][3].startswith("<object")
    assert back["df"] == {"x": [1, 2]} and back["ser"] == [1.5, 2.5]
    mixed = {1: "a", "b": 2, np.int64(2): 3}
    with pytest.raises(TypeError):
        json.dumps(mixed, sort_keys=True)
    assert json.dumps(hc.to_jsonable(mixed), sort_keys=True)

    class Bad:
        def __str__(self) -> str:
            raise RuntimeError("no str")

    assert hc.to_jsonable({"k": Bad()}) == {"k": "<unprintable>"}
    cyc: list[Any] = []
    cyc.append(cyc)
    assert json.dumps(hc.to_jsonable(cyc))


RID = "a" * 40
STATE0 = {"bytes": 0, "sha256": hashlib.sha256(b"").hexdigest()}


def _line(
    read_id: str = "b" * 40,
    finalist: str = "other-finalist",
    path: str = "/h/perp/X/5m.jsonl.gz",
    at: str | None = None,
) -> str:
    return (
        json.dumps(
            {"read_id": read_id, "finalist_id": finalist, "path": path, "at": at or "2026-11-06T10:00:00.000000Z"}
        )
        + "\n"
    )


def test_17_ledger_precheck_cases() -> None:
    ok = (_line() + _line("c" * 40)).encode()
    out = hc.ledger_precheck(ok, RID, STATE0, hc.FINALIST_ID)
    assert out["lines"] == 2 and out["distinct_read_ids"] == ["b" * 40, "c" * 40]
    state = {"bytes": len(_line().encode()), "sha256": hashlib.sha256(_line().encode()).hexdigest()}
    after = hc.ledger_precheck(ok, RID, state, hc.FINALIST_ID)
    assert len(after["lines_after_state"]) == 1 and after["lines_after_state"][0]["read_id"] == "c" * 40
    assert hc.ledger_precheck(b"", RID, STATE0, hc.FINALIST_ID)["lines"] == 0
    bad: dict[str, tuple[bytes, dict[str, Any]]] = {
        "own finalist": (_line(finalist=hc.FINALIST_ID).encode(), STATE0),
        "own read id": (_line(read_id=RID).encode(), STATE0),
        "four read ids": ("".join(_line(c * 40) for c in "bcde").encode(), STATE0),
        "unparsable": (b"{not json}\n", STATE0),
        "extra key": ((json.dumps({**json.loads(_line()), "x": 1}) + "\n").encode(), STATE0),
        "missing key": ((json.dumps({"read_id": "b" * 40, "finalist_id": "f", "path": "/x"}) + "\n").encode(), STATE0),
        "short read id": (_line(read_id="b" * 39).encode(), STATE0),
        "upper read id": (_line(read_id="B" * 40).encode(), STATE0),
        "bad finalist": (_line(finalist="Bad Id").encode(), STATE0),
        "relative path": (_line(path="h/x").encode(), STATE0),
        "naive time": (_line(at="2026-11-06T10:00:00").encode(), STATE0),
        "non utc time": (_line(at="2026-11-06T10:00:00+02:00").encode(), STATE0),
        "garbage time": (_line(at="yesterday").encode(), STATE0),
        "partial last line": (_line().encode() + b'{"read_id": "', STATE0),
        "prefix hash": (ok, {"bytes": len(_line().encode()), "sha256": "0" * 64}),
        "prefix too long": (_line().encode(), {"bytes": 10_000, "sha256": STATE0["sha256"]}),
        "prefix off a line boundary": (ok, {"bytes": 5, "sha256": hashlib.sha256(ok[:5]).hexdigest()}),
        "not a dict": (b"[1]\n", STATE0),
    }
    for name, (raw, st) in bad.items():
        with pytest.raises(ValueError):
            hc.ledger_precheck(raw, RID, st, hc.FINALIST_ID)
        assert name


def test_18_containment(tmp_path: Path) -> None:
    root = tmp_path / "root"
    (root / "sub").mkdir(parents=True)
    f = root / "sub" / "f.txt"
    f.write_text("x")
    assert hc.contained(f, root, "file") == str(f.resolve()) == str(f)
    assert hc.contained(root, root, "dir")
    outside = tmp_path / "outside.txt"
    outside.write_text("y")
    (root / "link.txt").symlink_to(outside)
    (root / "linkdir").symlink_to(tmp_path)
    for path, kind in (
        (root / "link.txt", "file"),
        (root / "linkdir" / "outside.txt", "file"),
        (outside, "file"),
        (root / "sub", "file"),
        (f, "dir"),
        (root / "missing", "file"),
    ):
        with pytest.raises(ValueError):
            hc.contained(path, root, kind)
    with pytest.raises(ValueError):
        hc.contained(f, root, "other")
    (tmp_path / "rootlink").symlink_to(root)
    with pytest.raises(ValueError):
        hc.contained(tmp_path / "rootlink", tmp_path / "rootlink", "dir")
    (tmp_path / "ledger.jsonl").write_bytes(b"")
    with pytest.raises(ValueError):
        hc.read_ledger(tmp_path)
    assert hc.read_ledger(tmp_path / "ledger.jsonl") == b""


# ---------------------------------------------------------------------------------------------------------------------
# End to end: a synthetic D export, the artifact run, a synthetic H export in the exporter's format
# ---------------------------------------------------------------------------------------------------------------------

COINS4 = ("BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT")
D_START = END - 200 * DAY
H_FIRST = method.H_START + 31 * DAY
H_DAYS = 165
ZERO_STATE = {"bytes": 0, "sha256": hashlib.sha256(b"").hexdigest()}


def _kline_rows(df: pd.DataFrame) -> pd.DataFrame:
    out = df[["t", "o", "h", "l", "c", "v"]].copy()
    out["qv"] = out["v"] * out["c"]
    out["n"] = 10
    out["tbv"] = out["v"] / 2.0
    return out


def _write_export(root: Path, panel: dict[str, dict[str, pd.DataFrame]], coins: tuple[str, ...]) -> dict[str, Any]:
    """The exporter's layout: perp klines and premium index at 5m, funding settlements, a manifest with row counts."""
    from r4.synth import _jsonl_gz_bytes

    entries: list[dict[str, Any]] = []

    def put(rel: str, df: pd.DataFrame, kind: str, symbol: str, interval: str) -> None:
        raw = _jsonl_gz_bytes(df)
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        t = df["t"].tolist()
        entries.append(
            {
                "path": rel,
                "kind": kind,
                "symbol": symbol,
                "interval": interval,
                "rowCount": len(df),
                "startMs": t[0] if t else None,
                "endMs": t[-1] if t else None,
                "sha256": hashlib.sha256(raw).hexdigest(),
            }
        )

    for c in coins:
        d = panel[c]
        put(f"perp/{c}/5m.jsonl.gz", _kline_rows(d["5m"]), "perp", c, "5m")
        prem = d["premium_5m"].copy()
        prem["o"] = prem["h"] = prem["l"] = prem["c"]
        put(f"perp/{c}/5m.premiumIndex.jsonl.gz", prem[["t", "o", "h", "l", "c"]], "perp", c, "5m")
        put(f"funding/{c}/settlements.jsonl.gz", d["settlements"], "funding", c, "8h")
    entries.sort(key=lambda e: e["path"])
    manifest = {"version": 1, "datasetHash": data.dataset_hash_of(entries), "symbols": list(coins), "files": entries}
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    return manifest


def _add_manifest_spans(ds: Path, panel: dict[str, dict[str, pd.DataFrame]]) -> None:
    """The exporter's rowCount, startMs and endMs on the 5m klines and premium entries of a synthetic D manifest."""
    manifest = json.loads((ds / "manifest.json").read_text())
    for entry in manifest["files"]:
        for c, d in panel.items():
            for key, template in hc.D_SPAN_FILES:
                if entry["path"] == template.format(c=c):
                    t = d[key]["t"].tolist()
                    entry.update({"rowCount": len(t), "startMs": t[0], "endMs": t[-1]})
    (ds / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")


def _entry_table(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    keys = ("path", "rowCount", "startMs", "endMs", "sha256")
    return [{k: f[k] for k in keys} for f in manifest["files"]]


def _h_panel(variant: str = "plain") -> dict[str, dict[str, pd.DataFrame]]:
    panel = _panel(COINS4, H_FIRST, H_DAYS, seed=41)
    if variant == "adversarial":
        panel["ETHUSDT"]["settlements"] = panel["ETHUSDT"]["settlements"].iloc[:1].copy()  # no usable funding
        sol = panel["SOLUSDT"]["5m"]
        panel["SOLUSDT"]["5m"] = sol[sol["t"] >= H_FIRST + 100 * DAY].reset_index(
            drop=True
        )  # under 90 days of forecasts
        xrp = panel["XRPUSDT"]["5m"]
        keep = (xrp["t"] < H_FIRST + 5 * DAY) | ((xrp["t"] % H) != 2 * BAR)  # no complete window after the warm-up
        panel["XRPUSDT"]["5m"] = xrp[keep].reset_index(drop=True)
    return panel


@pytest.fixture(scope="module")
def env(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    root = tmp_path_factory.mktemp("h38env")
    mp = pytest.MonkeyPatch()
    d_panel = _panel(COINS4, D_START, 200, seed=31)
    from r4.synth import write_synthetic_dataset

    ds = write_synthetic_dataset(d_panel, root / "ds")
    _add_manifest_spans(ds, d_panel)
    config = dict(
        family_c.family_c()[hc.REGISTRY_INDEX],
        first_refit_ms=D_START + 60 * DAY,
        min_train_windows=300,
        lookback_months=1,
        partition_end_ms=END,
    )
    from r4 import family_d, pipeline

    loaded = pipeline.load_panel(ds, list(COINS4))
    ref, _ = family_c.compute_forecasts(loaded, config)
    refits = family_c.refit_times(config["first_refit_ms"], END)
    ref_path = root / "ref" / "forecasts.parquet"
    ref_path.parent.mkdir()
    ref.to_parquet(ref_path)
    finite = ref.loc[np.isfinite(ref["f"].to_numpy())]
    spec = hc.Spec(
        coins=COINS4,
        dev_start=D_START,
        dev_end=END,
        cutoff_ms=refits[-1],
        lookback_months=1,
        min_train=300,
        symbols_min=3,
        d_dataset_hash=json.loads((ds / "manifest.json").read_text())["datasetHash"],
        reference_sha256=hashlib.sha256(ref_path.read_bytes()).hexdigest(),
        reference_finite_digest=family_d.canonical_digest(finite, "f"),
        reference_finite_rows=len(finite),
        config=config,
        dry_days=150,
    )
    mp.setattr(hc, "SPEC", spec)
    mp.setattr(cli, "reproduction_inputs", _good_repro)
    rep = root / "reproduction.json"
    rep.write_text(
        json.dumps({"all_match": True, "r4_source_sha256": cli.source_digest(), "dataset_hash": spec.d_dataset_hash})
    )
    art_out = root / "artifact-out"
    art_out.mkdir()
    art_result = hc.run_artifact(str(ds), str(ref_path), str(art_out), "c" * 40, str(rep))
    mp.undo()
    artifact_bytes = (art_out / "artifact.json").read_bytes()
    h_dir = root / "h"
    manifest = _write_export(h_dir, _h_panel(), COINS4)
    return {
        "root": root,
        "ds": ds,
        "ref": ref_path,
        "spec": spec,
        "config": config,
        "artifact_bytes": artifact_bytes,
        "art_out": art_out,
        "art_result": art_result,
        "reproduction": rep,
        "h_dir": h_dir,
        "h_manifest": manifest,
        "h_table": _entry_table(manifest),
        "h_hash": manifest["datasetHash"],
    }


class Ctx:
    """One test's mounts, bindings and run helpers, with every module path patched to tmp locations."""

    def __init__(self, env: dict[str, Any], tmp: Path, mp: pytest.MonkeyPatch) -> None:
        self.env, self.tmp, self.mp = env, tmp, mp
        mp.setattr(hc, "SPEC", env["spec"])
        mp.setattr(hc, "_expected_spec", lambda: env["spec"])
        mp.setattr(cli, "reproduction_inputs", _good_repro)
        self.out = tmp / "out"
        self.out.mkdir()
        self.scratch = tmp / "scratch" / "ledger.jsonl"
        self.scratch.parent.mkdir()
        self.scratch.write_bytes(b"")
        self.real_ledger = tmp / "real" / "holdout-reads.jsonl"
        self.real_ledger.parent.mkdir()
        self.real_ledger.write_bytes(b"")
        self.h_dir = env["h_dir"]
        self.artifact = tmp / "artifact.json"
        self.artifact.write_bytes(env["artifact_bytes"])
        self.mount()
        self.fake_real_table = [{**f, "sha256": hashlib.sha256(f["path"].encode()).hexdigest()} for f in env["h_table"]]

    def mount(self) -> None:
        self.mp.setattr(hc, "D_DIR", str(self.env["ds"]))
        self.mp.setattr(hc, "REF_PATH", str(self.env["ref"]))
        self.mp.setattr(hc, "OUT_DIR", str(self.out))
        self.mp.setattr(hc, "REHEARSAL_H_DIR", str(self.h_dir))
        self.mp.setattr(hc, "REHEARSAL_LEDGER_PATH", str(self.scratch))
        self.mp.setattr(hc, "H_DIR", str(self.tmp / "no-real-h"))
        self.mp.setattr(hc, "LEDGER_PATH", str(self.real_ledger))
        self.mp.setattr(hc, "LOCK_RECORD_PATH", str(self.tmp / "lock.json"))
        self.mp.setattr(hc, "ARTIFACT_RECORD_PATH", str(self.artifact))

    def h_copy(self) -> Path:
        import shutil

        dest = self.tmp / "h-copy"
        shutil.copytree(self.env["h_dir"], dest)
        self.h_dir = dest
        self.mount()
        return dest

    def bindings(self, **over: Any) -> dict[str, Any]:
        e = self.env
        art = json.loads(e["artifact_bytes"])
        b = {
            "source_sha256": cli.source_digest(),
            "holdout_c_sha256": hashlib.sha256(Path(hc.__file__).read_bytes()).hexdigest(),
            "artifact_sha256": hashlib.sha256(e["artifact_bytes"]).hexdigest(),
            "model_sha256": art["model_sha256"],
            "reference_forecasts_sha256": e["spec"].reference_sha256,
            "h_dataset_hash": "f" * 64,
            "h_files": self.fake_real_table,
            "rehearsal_h_dataset_hash": e["h_hash"],
            "ledger_state": ZERO_STATE,
        }
        return {**b, **over}

    def rehearse_kwargs(self, **over: Any) -> dict[str, Any]:
        bpath = self.tmp / "bindings.json"
        bpath.write_text(json.dumps(over.pop("bindings", self.bindings())))
        kw = {
            "mode": "rehearsal",
            "ds": str(self.env["ds"]),
            "h": str(self.h_dir),
            "ref": str(self.env["ref"]),
            "lock": None,
            "artifact": str(self.artifact),
            "read_id": RID,
            "commit": RID,
            "ledger": str(self.scratch),
            "out": str(self.out),
            "bindings_path": str(bpath),
        }
        return {**kw, **over}

    def identity(self) -> dict[str, Any]:
        return {
            "finalist": hc.FINALIST_CONFIG_ID,
            "finalist_id": hc.FINALIST_ID,
            "registry_index": hc.REGISTRY_INDEX,
            "config_hash": hc.CONFIG_HASH,
        }

    def read_kwargs(self, **over: Any) -> dict[str, Any]:
        self.mp.setattr(hc, "H_DIR", str(self.h_dir))
        bindings = self.bindings(h_dataset_hash=self.env["h_hash"], h_files=self.env["h_table"])
        lock = self.tmp / "lock.json"
        lock.write_text(json.dumps({**self.identity(), "bindings": over.pop("bindings", bindings)}))
        kw = {
            "mode": "read",
            "ds": str(self.env["ds"]),
            "h": str(self.h_dir),
            "ref": str(self.env["ref"]),
            "lock": str(lock),
            "artifact": str(self.artifact),
            "read_id": "b" * 40,
            "commit": "b" * 40,
            "ledger": str(self.real_ledger),
            "out": str(self.out),
        }
        return {**kw, **over}


@pytest.fixture
def ctx(env: dict[str, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Ctx:
    return Ctx(env, tmp_path, monkeypatch)


def _spy_loaders(mp: pytest.MonkeyPatch) -> list[tuple[str, str, str]]:
    """Records every data.load_perp call as (symbol, series, finalist id) and forwards it."""
    calls: list[tuple[str, str, str]] = []
    real = data.load_perp

    def spy(dir: Any, symbol: str, interval: str, series: str = "klines", **kw: Any) -> Any:
        calls.append((symbol, series, str(kw.get("holdout_finalist_id"))))
        return real(dir, symbol, interval, series=series, **kw)

    mp.setattr(data, "load_perp", spy)
    return calls


def _forbid_loaders(mp: pytest.MonkeyPatch) -> list[int]:
    calls: list[int] = []

    def fail(*a: Any, **k: Any) -> Any:
        calls.append(1)
        raise AssertionError("a guarded loader was called")

    mp.setattr(data, "load_perp", fail)
    return calls


def test_artifact_run_binds_and_writes(env: dict[str, Any]) -> None:
    out = env["art_out"]
    assert sorted(p.name for p in out.iterdir()) == ["artifact.json", "binding.json", "receipt.json"]
    raw = env["artifact_bytes"]
    art = json.loads(raw)
    assert raw == hc.canonical_bytes(art) and art["artifact"] == hc.ARTIFACT_KIND
    assert art["model_sha256"] == hashlib.sha256(hc.canonical_bytes(art["model"])).hexdigest()
    assert set(art["model"]) == set(COINS4) and set(art["descriptive"]) == set(COINS4)
    assert art["provenance"]["binding"]["B4"] == dict.fromkeys(COINS4, True)
    assert (
        art["provenance"]["reproduction_record"]["sha256"]
        == hashlib.sha256(env["reproduction"].read_bytes()).hexdigest()
    )
    binding = json.loads((out / "binding.json").read_text())
    assert binding["D_manifest"]["all_match"] and binding["D_manifest"]["files"] == 2 * len(COINS4)
    assert (
        binding["B1"]["equal"]
        and binding["B2"]["equal"]
        and binding["artifact_sha256"] == env["art_result"]["artifact_sha256"]
    )
    receipt = json.loads((out / "receipt.json").read_text())
    assert receipt["outputs_sha256"]["artifact.json"] == hashlib.sha256(raw).hexdigest()
    assert (out / "receipt.json").stat().st_mtime_ns >= (out / "artifact.json").stat().st_mtime_ns


def test_artifact_run_refuses(env: dict[str, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(hc, "SPEC", env["spec"])
    monkeypatch.setattr(cli, "reproduction_inputs", _good_repro)
    ds, ref = str(env["ds"]), str(env["ref"])
    out = tmp_path / "o"
    out.mkdir()
    bad = tmp_path / "rep.json"
    for body in (
        {"all_match": False, "r4_source_sha256": cli.source_digest()},
        {"all_match": True, "r4_source_sha256": "0" * 64},
        {"all_match": True, "r4_source_sha256": cli.source_digest()},
        {"all_match": True, "r4_source_sha256": cli.source_digest(), "dataset_hash": "0" * 64},
    ):
        bad.write_text(json.dumps(body))
        with pytest.raises(ValueError, match="reproduction record"):
            hc.run_artifact(ds, ref, str(out), "c" * 40, str(bad))
    (out / "x").write_text("x")
    with pytest.raises(ValueError, match="not empty"):
        hc.run_artifact(ds, ref, str(out), "c" * 40, str(env["reproduction"]))
    out2 = tmp_path / "o2"
    out2.mkdir()
    with pytest.raises(ValueError, match="commit"):
        hc.run_artifact(ds, ref, str(out2), "XYZ", str(env["reproduction"]))
    assert list(out2.iterdir()) == []
    perturbed = tmp_path / "perturbed.parquet"
    frame = pd.read_parquet(ref)
    frame.loc[len(frame) // 2, "f"] = np.nextafter(frame.loc[len(frame) // 2, "f"], np.inf)
    frame.to_parquet(perturbed)
    monkeypatch.setattr(
        hc,
        "SPEC",
        hc.Spec(**{**env["spec"].__dict__, "reference_sha256": hashlib.sha256(perturbed.read_bytes()).hexdigest()}),
    )
    with pytest.raises(ValueError, match="B1"):
        hc.run_artifact(ds, str(perturbed), str(out2), "c" * 40, str(env["reproduction"]))
    assert list(out2.iterdir()) == []


# ---------------------------------------------------------------------------------------------------------------------
# 19 rehearsal end to end, read mode end to end
# ---------------------------------------------------------------------------------------------------------------------


def _ledger_lines(path: Path) -> list[dict[str, Any]]:
    return [json.loads(x) for x in path.read_text().splitlines() if x.strip()]


def test_19_rehearsal_end_to_end(ctx: Ctx, capsys: pytest.CaptureFixture[str]) -> None:
    calls = _spy_loaders(ctx.mp)
    res = hc.run_read(**ctx.rehearse_kwargs())
    log = capsys.readouterr().out
    assert log.index("PRELOAD OK") < log.index("H VERDICT") < log.index("H RECORD")
    assert f"H VERDICT {hc.REHEARSAL_FINALIST_ID} pass=" in log and "flag1=" in log
    lines = _ledger_lines(ctx.scratch)
    assert len(lines) == 2 * len(COINS4) == len(calls)
    assert {x["finalist_id"] for x in lines} == {hc.REHEARSAL_FINALIST_ID} and {x["read_id"] for x in lines} == {RID}
    assert [x["path"] for x in lines] == [str(ctx.h_dir / p.format(c=c)) for c in COINS4 for p in hc.H_GUARDED]
    assert not any("settlements" in x["path"] for x in lines)
    assert {c[2] for c in calls} == {hc.REHEARSAL_FINALIST_ID} and hc.FINALIST_ID not in {c[2] for c in calls}
    assert sorted(p.name for p in ctx.out.iterdir()) == [
        "h_forecasts.parquet",
        "h_report.json",
        "receipt.json",
        "verdict.txt",
    ]
    assert (ctx.out / "receipt.json").stat().st_mtime_ns >= (ctx.out / "h_report.json").stat().st_mtime_ns
    report = json.loads((ctx.out / "h_report.json").read_text())
    receipt = json.loads((ctx.out / "receipt.json").read_text())
    assert report["gated"]["errors"] == [] and res["write_failures"] == []
    verdict_lines = (ctx.out / "verdict.txt").read_text().splitlines()
    assert verdict_lines[0] in log and verdict_lines[1] in log and verdict_lines[0].startswith("H VERDICT")
    assert json.loads(verdict_lines[1].removeprefix("H RECORD "))["h_pass"] == res["h_pass"]
    assert len(receipt["ledger_lines_added"]) == 2 * len(COINS4) and receipt["mode"] == "rehearsal"
    assert receipt["h_dataset_hash"] == ctx.env["h_hash"] and len(receipt["funding_records"]) == len(COINS4)
    assert (
        receipt["outputs_sha256"]["h_report.json"]
        == hashlib.sha256((ctx.out / "h_report.json").read_bytes()).hexdigest()
    )
    assert receipt["peaks_mib_after"]["self_mib"] > 0 and receipt["d_phase"]["binding"]["B4"]
    assert all(r["match"] for r in report["load_records"]) and "forecast_range" in report["descriptive"]
    assert pd.read_parquet(ctx.out / "h_forecasts.parquet").shape[0] > 1000
    gated = report["gated"]
    assert gated["stay_out"]["flag1"]["seed"] == 12_200_002 and gated["verdict"]["n_coins"] == len(COINS4)
    # a second run is refused before any load, the ledger byte for byte unchanged
    before = ctx.scratch.read_bytes()
    out2 = ctx.tmp / "out2"
    out2.mkdir()
    ctx.mp.setattr(hc, "OUT_DIR", str(out2))
    calls2 = _forbid_loaders(ctx.mp)
    with pytest.raises(ValueError, match="already holds"):
        hc.run_read(**ctx.rehearse_kwargs(out=str(out2)))
    assert ctx.scratch.read_bytes() == before and calls2 == [] and list(out2.iterdir()) == []


def test_19_read_mode_end_to_end(ctx: Ctx, capsys: pytest.CaptureFixture[str]) -> None:
    calls = _spy_loaders(ctx.mp)
    res = hc.run_read(**ctx.read_kwargs())
    log = capsys.readouterr().out
    assert f"H VERDICT {hc.FINALIST_ID} pass=" in log
    lines = _ledger_lines(ctx.real_ledger)
    assert {x["finalist_id"] for x in lines} == {hc.FINALIST_ID} and {x["read_id"] for x in lines} == {"b" * 40}
    assert {c[2] for c in calls} == {hc.FINALIST_ID}
    receipt = json.loads((ctx.out / "receipt.json").read_text())
    assert (
        receipt["mode"] == "read"
        and receipt["lock_record_sha256"] == hashlib.sha256((ctx.tmp / "lock.json").read_bytes()).hexdigest()
    )
    assert res["report"]["gated"]["h_pass"] in (True, False)


def test_20_mode_isolation(ctx: Ctx) -> None:
    calls = _forbid_loaders(ctx.mp)
    ledger_before = ctx.real_ledger.read_bytes()
    # rehearsal: the real H directory, the real ledger, another datasetHash, a file hash of the real export
    with pytest.raises(ValueError, match="never touches"):
        hc.run_read(**ctx.rehearse_kwargs(h=hc.H_DIR))
    with pytest.raises(ValueError, match="never touches"):
        hc.run_read(**ctx.rehearse_kwargs(ledger=hc.LEDGER_PATH))
    with pytest.raises(ValueError, match="datasetHash"):
        hc.run_read(**ctx.rehearse_kwargs(bindings=ctx.bindings(rehearsal_h_dataset_hash="0" * 64)))
    real_table = [
        {**f, "sha256": ctx.env["h_table"][0]["sha256"]} if i == 0 else f for i, f in enumerate(ctx.fake_real_table)
    ]
    with pytest.raises(ValueError, match="real H export"):
        hc.run_read(**ctx.rehearse_kwargs(bindings=ctx.bindings(h_files=real_table)))
    # read mode: any ledger other than LEDGER_PATH, any H directory other than H_DIR
    kw = ctx.read_kwargs()
    other = ctx.tmp / "other-ledger.jsonl"
    other.write_bytes(b"")
    with pytest.raises(ValueError, match="ledger must be"):
        hc.run_read(**{**kw, "ledger": str(other)})
    with pytest.raises(ValueError, match="H directory must be"):
        hc.run_read(**{**kw, "h": str(ctx.tmp)})
    with pytest.raises(ValueError, match="read id must equal"):
        hc.run_read(**{**kw, "read_id": "c" * 40})
    with pytest.raises(ValueError, match="mode"):
        hc.run_read(**{**kw, "mode": "other"})
    assert calls == [] and ctx.real_ledger.read_bytes() == ledger_before == b""
    assert ctx.scratch.read_bytes() == b""


# ---------------------------------------------------------------------------------------------------------------------
# 13 to 16: nothing raises after the first guarded load
# ---------------------------------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def adversarial_h(env: dict[str, Any]) -> dict[str, Any]:
    root = env["root"] / "h-adv"
    manifest = _write_export(root, _h_panel("adversarial"), COINS4)
    return {"dir": root, "hash": manifest["datasetHash"]}


def test_13_adversarial_panel_completes(
    ctx: Ctx, adversarial_h: dict[str, Any], capsys: pytest.CaptureFixture[str]
) -> None:
    ctx.h_dir = adversarial_h["dir"]
    ctx.mount()
    kw = ctx.rehearse_kwargs(bindings=ctx.bindings(rehearsal_h_dataset_hash=adversarial_h["hash"]))
    res = hc.run_read(**kw)
    log = capsys.readouterr().out
    assert "H VERDICT" in log and "H RECORD" in log
    report = json.loads((ctx.out / "h_report.json").read_text())
    gated = report["gated"]
    assert gated["errors"] == [] and res["h_pass"] is False and gated["verdict"]["n_coins_pass"] == 0
    assert gated["stay_out"]["flag2"]["reason"] == "no flagged window"
    rng = report["descriptive"]["forecast_range"]
    assert rng["XRPUSDT"]["finite_f_rows"] == 0 and rng["ETHUSDT"]["finite_f_rows"] == 0
    sol = rng["SOLUSDT"]["finite_f_rows"]
    assert 0 < sol < 90 * 24
    assert rng["BTCUSDT"]["finite_f_rows"] > 90 * 24
    assert (ctx.out / "receipt.json").is_file() and (ctx.out / "h_forecasts.parquet").is_file()


def _edit_manifest(root: Path, path: str, **fields: Any) -> None:
    mpath = root / "manifest.json"
    manifest = json.loads(mpath.read_text())
    for f in manifest["files"]:
        if f["path"] == path:
            f.update(fields)
    mpath.write_text(json.dumps(manifest, indent=2, sort_keys=True))


def _count(root: Path, path: str) -> int:
    return next(f["rowCount"] for f in json.loads((root / "manifest.json").read_text())["files"] if f["path"] == path)


@pytest.mark.parametrize(
    ("coin", "series", "field", "delta"),
    [
        ("ETHUSDT", "perp/ETHUSDT/5m.jsonl.gz", "rowCount", 1),
        ("ETHUSDT", "perp/ETHUSDT/5m.premiumIndex.jsonl.gz", "rowCount", -1),
        ("SOLUSDT", "perp/SOLUSDT/5m.jsonl.gz", "startMs", BAR),
        ("SOLUSDT", "perp/SOLUSDT/5m.premiumIndex.jsonl.gz", "endMs", -BAR),
        ("BTCUSDT", "perp/BTCUSDT/5m.jsonl.gz", "rowCount", 1),
        ("BTCUSDT", "perp/BTCUSDT/5m.premiumIndex.jsonl.gz", "endMs", BAR),
    ],
)
def test_14_a_load_mismatch_fails_the_coin_and_the_flag(
    ctx: Ctx, capsys: pytest.CaptureFixture[str], coin: str, series: str, field: str, delta: int
) -> None:
    root = ctx.h_copy()
    cur = next(f[field] for f in json.loads((root / "manifest.json").read_text())["files"] if f["path"] == series)
    _edit_manifest(root, series, **{field: cur + delta})
    res = hc.run_read(**ctx.rehearse_kwargs())
    log = capsys.readouterr().out
    rec = res["record"]
    assert [(e["coin"], e["stage"]) for e in rec["errors"]] == [(coin, "load mismatch")]
    assert coin not in rec["per_coin"] and set(rec["per_coin"]) == set(COINS4) - {coin}
    assert rec["stay_out"]["reason"] == "forecasts undefined" and rec["stay_out"]["coins"] == [coin]
    assert rec["h_pass"] is False
    assert "pass=False" in log and "flag1=False flag2=False" in log
    assert [r["match"] for r in res["report"]["load_records"] if r["path"] == series] == [False]
    # BTC's table still serves every other coin, so their criteria were computed from real forecasts
    others = [c for c in COINS4 if c != coin]
    assert all(rec["per_coin"][c]["n_rows"] > 0 for c in others)
    assert len(_ledger_lines(ctx.scratch)) == 2 * len(COINS4)


def test_14_a_loader_exception_ends_the_run(
    ctx: Ctx, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    real = data.load_perp
    seen: list[tuple[str, str]] = []

    def flaky(dir: Any, symbol: str, interval: str, series: str = "klines", **kw: Any) -> Any:
        seen.append((symbol, series))
        if (symbol, series) == ("ETHUSDT", "premiumIndex"):
            raise RuntimeError("disk boom")
        return real(dir, symbol, interval, series=series, **kw)

    ctx.mp.setattr(data, "load_perp", flaky)
    evaluated: list[int] = []
    real_eval = hc.evaluate_gated
    ctx.mp.setattr(hc, "evaluate_gated", lambda *a, **k: evaluated.append(1) or real_eval(*a, **k))
    # the dry run calls evaluate_gated before the load, so count only the calls after the first guarded load
    with pytest.raises(RuntimeError, match="disk boom"):
        hc.run_read(**ctx.rehearse_kwargs())
    log = capsys.readouterr().out
    assert "PRELOAD OK" in log and "H VERDICT" not in log and "H RECORD" not in log
    assert len(_ledger_lines(ctx.scratch)) == 3 and seen[-1] == ("ETHUSDT", "premiumIndex")
    assert len(evaluated) == 1  # the dry run's call only
    assert list(ctx.out.iterdir()) == []


def test_16_descriptive_and_write_failures(ctx: Ctx, capsys: pytest.CaptureFixture[str]) -> None:
    ctx.mp.setattr(hc, "describe_h", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("describe boom")))
    res = hc.run_read(**ctx.rehearse_kwargs())
    log = capsys.readouterr().out
    assert "H VERDICT" in log and "H RECORD" in log and res["write_failures"] == []
    report = json.loads((ctx.out / "h_report.json").read_text())
    assert "describe boom" in report["descriptive"]["error"] and report["gated"]["errors"] == []


def test_16_a_failed_parquet_write_keeps_the_verdict(ctx: Ctx, capsys: pytest.CaptureFixture[str]) -> None:
    ctx.mp.setattr(pd.DataFrame, "to_parquet", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    res = hc.run_read(**ctx.rehearse_kwargs())
    log = capsys.readouterr().out
    assert "H VERDICT" in log and "H RECORD" in log and "WRITE FAILED h_forecasts.parquet" in log
    assert (ctx.out / "h_report.json").is_file() and not (ctx.out / "h_forecasts.parquet").exists()
    assert len(res["write_failures"]) == 1
    receipt = json.loads((ctx.out / "receipt.json").read_text())
    assert receipt["write_failures"] and "disk full" in receipt["write_failures"][0]
    assert "error" in receipt["outputs_sha256"]["h_forecasts.parquet"]
    ctx.mp.undo()


def test_16_a_failed_report_write_still_writes_the_receipt(ctx: Ctx, capsys: pytest.CaptureFixture[str]) -> None:
    real = hc._write_bytes

    def flaky(path: Path, raw: bytes) -> None:
        if path.name == "h_report.json":
            raise OSError("report boom")
        real(path, raw)

    ctx.mp.setattr(hc, "_write_bytes", flaky)
    res = hc.run_read(**ctx.rehearse_kwargs())
    log = capsys.readouterr().out
    assert "H VERDICT" in log and "WRITE FAILED h_report.json" in log
    assert (ctx.out / "receipt.json").is_file() and len(res["write_failures"]) == 1


# ---------------------------------------------------------------------------------------------------------------------
# 17, 18, 21: refusals before any guarded load
# ---------------------------------------------------------------------------------------------------------------------


def _bad_ledger_cases() -> dict[str, bytes]:
    fid = hc.REHEARSAL_FINALIST_ID
    return {
        "own finalist": _line(finalist=fid).encode(),
        "own read id": _line(read_id=RID).encode(),
        "four read ids": "".join(_line(c * 40) for c in "bcde").encode(),
        "unparsable": b"garbage\n",
        "extra key": (json.dumps({**json.loads(_line()), "x": 1}) + "\n").encode(),
        "wrong read id form": _line(read_id="z" * 40).encode(),
        "partial last line": _line().encode() + b'{"read_id"',
    }


@pytest.mark.parametrize("case", list(_bad_ledger_cases()))
def test_17_ledger_refusals_precede_every_load(ctx: Ctx, case: str) -> None:
    calls = _forbid_loaders(ctx.mp)
    ctx.scratch.write_bytes(_bad_ledger_cases()[case])
    before = ctx.scratch.read_bytes()
    with pytest.raises(ValueError):
        hc.run_read(**ctx.rehearse_kwargs())
    assert calls == [] and ctx.scratch.read_bytes() == before and list(ctx.out.iterdir()) == []


def test_17_a_prefix_that_does_not_hash_to_the_state(ctx: Ctx) -> None:
    calls = _forbid_loaders(ctx.mp)
    ctx.scratch.write_bytes(_line().encode())
    state = {"bytes": len(_line().encode()), "sha256": "0" * 64}
    with pytest.raises(ValueError, match="bound state"):
        hc.run_read(**ctx.rehearse_kwargs(bindings=ctx.bindings(ledger_state=state)))
    good = {"bytes": len(_line().encode()), "sha256": hashlib.sha256(_line().encode()).hexdigest()}
    assert good["bytes"] > 0 and calls == []


def test_17_a_ledger_changed_after_the_precheck(ctx: Ctx) -> None:
    calls = _spy_loaders(ctx.mp)
    real_log = hc._log

    def log(message: str) -> None:
        real_log(message)
        if message.startswith("PRELOAD OK"):
            with open(ctx.scratch, "ab") as f:
                f.write(_line().encode())

    ctx.mp.setattr(hc, "_log", log)
    with pytest.raises(ValueError, match="ledger changed"):
        hc.run_read(**ctx.rehearse_kwargs())
    assert calls == [] and ctx.scratch.read_bytes() == _line().encode()


def test_17_a_prior_ledger_state_with_other_finalists_is_accepted(ctx: Ctx) -> None:
    prior = _line("c" * 40, "other-finalist").encode()
    ctx.scratch.write_bytes(prior)
    state = {"bytes": len(prior), "sha256": hashlib.sha256(prior).hexdigest()}
    hc.run_read(**ctx.rehearse_kwargs(bindings=ctx.bindings(ledger_state=state)))
    lines = _ledger_lines(ctx.scratch)
    assert len(lines) == 1 + 2 * len(COINS4) and lines[0]["read_id"] == "c" * 40


def test_18_path_containment_in_run_read(ctx: Ctx) -> None:
    calls = _forbid_loaders(ctx.mp)
    # a symlink inside the H directory pointing outside it
    root = ctx.h_copy()
    victim = root / "perp" / "BTCUSDT" / "5m.jsonl.gz"
    elsewhere = ctx.tmp / "elsewhere.gz"
    elsewhere.write_bytes(victim.read_bytes())
    victim.unlink()
    victim.symlink_to(elsewhere)
    with pytest.raises(ValueError, match="symlink|outside"):
        hc.run_read(**ctx.rehearse_kwargs())
    # a symlinked ledger
    ctx2_ledger = ctx.tmp / "ledger-link.jsonl"
    ctx2_ledger.symlink_to(ctx.scratch)
    ctx.mp.setattr(hc, "REHEARSAL_LEDGER_PATH", str(ctx2_ledger))
    with pytest.raises(ValueError, match="symlink|outside"):
        hc.run_read(**ctx.rehearse_kwargs(ledger=str(ctx2_ledger)))
    # a non-directory mount root
    ctx.mp.setattr(hc, "REHEARSAL_H_DIR", str(elsewhere))
    ctx.mp.setattr(hc, "REHEARSAL_LEDGER_PATH", str(ctx.scratch))
    with pytest.raises(ValueError, match="not a directory"):
        hc.run_read(**ctx.rehearse_kwargs(h=str(elsewhere), ledger=str(ctx.scratch)))
    # a directory at the ledger path
    adir = ctx.tmp / "adir"
    adir.mkdir()
    ctx.mp.setattr(hc, "REHEARSAL_LEDGER_PATH", str(adir))
    ctx.mp.setattr(hc, "REHEARSAL_H_DIR", str(ctx.env["h_dir"]))
    with pytest.raises(ValueError, match="not a regular file"):
        hc.run_read(**ctx.rehearse_kwargs(h=str(ctx.env["h_dir"]), ledger=str(adir)))
    assert calls == [] and ctx.scratch.read_bytes() == b""


def _set_spec(mp: pytest.MonkeyPatch, spec: hc.Spec) -> None:
    """A test spec that is also the locked one (the read-mode SPEC check passes on it)."""
    mp.setattr(hc, "SPEC", spec)
    mp.setattr(hc, "_expected_spec", lambda: spec)


def _perturbed_reference(ctx: Ctx) -> None:
    ref = ctx.env["ref"]
    perturbed = ctx.tmp / "perturbed.parquet"
    frame = pd.read_parquet(ref)
    spec = ctx.env["spec"]
    idx = int(np.flatnonzero((frame["fold"] == spec.cutoff_ms).to_numpy() & np.isfinite(frame["f"].to_numpy()))[5])
    frame.loc[idx, "f"] = np.nextafter(frame.loc[idx, "f"], np.inf)
    frame.to_parquet(perturbed)
    ctx.mp.setattr(hc, "REF_PATH", str(perturbed))
    _set_spec(
        ctx.mp, hc.Spec(**{**spec.__dict__, "reference_sha256": hashlib.sha256(perturbed.read_bytes()).hexdigest()})
    )


def _pre_load_cases() -> dict[str, Callable[[Ctx], tuple[dict[str, Any], str]]]:
    def spec_with(ctx: Ctx, **kw: Any) -> None:
        _set_spec(ctx.mp, hc.Spec(**{**ctx.env["spec"].__dict__, **kw}))

    def art_sha(ctx: Ctx) -> tuple[dict[str, Any], str]:
        return {"bindings": ctx.bindings(artifact_sha256="0" * 64)}, "artifact file"

    def model_sha(ctx: Ctx) -> tuple[dict[str, Any], str]:
        return {"bindings": ctx.bindings(model_sha256="0" * 64)}, "model sha256"

    def perturbed(ctx: Ctx) -> tuple[dict[str, Any], str]:
        _perturbed_reference(ctx)
        ctx.mount()
        ctx.mp.setattr(hc, "REF_PATH", str(ctx.tmp / "perturbed.parquet"))
        return {
            "ref": str(ctx.tmp / "perturbed.parquet"),
            "bindings": ctx.bindings(reference_forecasts_sha256=hc.SPEC.reference_sha256),
        }, "B2"

    def partition(ctx: Ctx) -> tuple[dict[str, Any], str]:
        spec_with(ctx, dev_end=END - 10 * DAY)
        return {}, "partition"

    def wrong_d_hash(ctx: Ctx) -> tuple[dict[str, Any], str]:
        spec_with(ctx, d_dataset_hash="0" * 64)
        return {}, "datasetHash"

    def h_hash(ctx: Ctx) -> tuple[dict[str, Any], str]:
        return {"bindings": ctx.bindings(rehearsal_h_dataset_hash="1" * 64)}, "datasetHash"

    def missing_file(ctx: Ctx) -> tuple[dict[str, Any], str]:
        root = ctx.h_copy()
        (root / "perp" / "XRPUSDT" / "5m.premiumIndex.jsonl.gz").unlink()
        return {"h": str(root)}, "verify_manifest"

    def digest(ctx: Ctx) -> tuple[dict[str, Any], str]:
        return {"bindings": ctx.bindings(source_sha256="2" * 64)}, "source digest"

    def holdout_sha(ctx: Ctx) -> tuple[dict[str, Any], str]:
        return {"bindings": ctx.bindings(holdout_c_sha256="3" * 64)}, "holdout_c_sha256"

    def nonempty_out(ctx: Ctx) -> tuple[dict[str, Any], str]:
        (ctx.out / "leftover").write_text("x")
        return {}, "not empty"

    def failing_dry_run(ctx: Ctx) -> tuple[dict[str, Any], str]:
        ctx.mp.setattr(family_c, "coin_criteria", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("criteria boom")))
        return {}, "dry run"

    def n5(ctx: Ctx) -> tuple[dict[str, Any], str]:
        real = hc.forecast_frame

        def ff(prep: Any, fits: Any, lo: int, hi: int, **kw: Any) -> Any:
            if kw["coins"] == ("ETHUSDT",):
                raise RuntimeError("forecast boom")
            return real(prep, fits, lo, hi, **kw)

        ctx.mp.setattr(hc, "forecast_frame", ff)
        return {}, "dry run"

    def h_files_field(field: str) -> Callable[[Ctx], tuple[dict[str, Any], str]]:
        def case(ctx: Ctx) -> tuple[dict[str, Any], str]:
            table = [dict(f) for f in ctx.env["h_table"]]
            table[3][field] = table[3][field] + 1
            kw = ctx.read_kwargs(bindings=ctx.bindings(h_dataset_hash=ctx.env["h_hash"], h_files=table))
            return {"__read__": kw}, "bound entry"

        return case

    return {
        "wrong artifact sha": art_sha,
        "wrong model sha": model_sha,
        "perturbed reference": perturbed,
        "D partition violation": partition,
        "wrong D datasetHash (child raises)": wrong_d_hash,
        "wrong H datasetHash": h_hash,
        "missing H file": missing_file,
        "source digest mismatch": digest,
        "holdout_c sha mismatch": holdout_sha,
        "non-empty output": nonempty_out,
        "failing dry run": failing_dry_run,
        "dry run caught exception (N5)": n5,
        "h_files rowCount": h_files_field("rowCount"),
        "h_files startMs": h_files_field("startMs"),
        "h_files endMs": h_files_field("endMs"),
    }


@pytest.mark.parametrize("name", list(_pre_load_cases()))
def test_21_pre_load_failures(ctx: Ctx, name: str) -> None:
    calls = _forbid_loaders(ctx.mp)
    over, match = _pre_load_cases()[name](ctx)
    if "__read__" in over:
        kw = over["__read__"]
        ledger = ctx.real_ledger
    else:
        kw = ctx.rehearse_kwargs(**over)
        ledger = ctx.scratch
    with pytest.raises(Exception, match=match):
        hc.run_read(**kw)
    assert (
        calls == [] and ledger.read_bytes() == b"" and sorted(p.name for p in ctx.out.iterdir()) in ([], ["leftover"])
    )


def test_21_a_version_mismatch_is_refused_before_loading(ctx: Ctx) -> None:
    calls = _forbid_loaders(ctx.mp)
    ctx.mp.setattr(cli, "reproduction_inputs", lambda: {**_good_repro(), "versions": {**GOOD_VERSIONS, "numpy": "9"}})
    with pytest.raises(ValueError, match="library versions"):
        hc.run_read(**ctx.rehearse_kwargs())
    assert calls == [] and ctx.scratch.read_bytes() == b""


def test_23_run_holdout_stays_the_stub() -> None:
    with pytest.raises(NotImplementedError):
        family_c.run_holdout()
    assert holdout_c is hc


def test_main_parses_subcommands(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict[str, Any] = {}
    monkeypatch.setattr(hc, "run_read", lambda **kw: seen.update(kw))
    monkeypatch.setattr(hc, "run_artifact", lambda *a: seen.update({"artifact": a}))
    base = ["--ds", "/ds", "--h", "/h", "--ref", "/r", "--artifact", "/a", "--read-id", "a" * 40, "--commit", "a" * 40]
    assert hc.main(["read", *base, "--ledger", "/l", "--out", "/o", "--lock", "/k"]) == 0
    assert seen["mode"] == "read" and seen["lock"] == "/k" and seen["bindings_path"] is None
    assert hc.main(["rehearse", *base, "--ledger", "/l", "--out", "/o", "--bindings", "/b"]) == 0
    assert seen["mode"] == "rehearsal" and seen["bindings_path"] == "/b" and seen["lock"] is None
    assert (
        hc.main(["artifact", "--ds", "/d", "--ref", "/r", "--out", "/o", "--commit", "abc1234", "--reproduction", "/p"])
        == 0
    )
    assert seen["artifact"] == ("/d", "/r", "/o", "abc1234", "/p")
    with pytest.raises(SystemExit):
        hc.main(["read", *base, "--ledger", "/l", "--out", "/o"])
    with pytest.raises(SystemExit):
        hc.main([])


# ---------------------------------------------------------------------------------------------------------------------
# Brief 38b: Opus fixes R1 to R4, Codex findings 1 to 3 and the Opus recommendations
# ---------------------------------------------------------------------------------------------------------------------


def test_r1_rehearsal_needs_the_full_real_table(ctx: Ctx) -> None:
    calls = _forbid_loaders(ctx.mp)
    partial = ctx.fake_real_table[1:]
    for bindings, match in (
        (ctx.bindings(h_files=[]), "full file table"),
        (ctx.bindings(h_files=partial), "full file table"),
        (ctx.bindings(h_files=[{**f, "sha256": "x"} for f in ctx.fake_real_table]), "64-hex"),
        (ctx.bindings(h_dataset_hash=ctx.env["h_hash"]), "equals the real H datasetHash"),
    ):
        with pytest.raises(ValueError, match=match):
            hc.run_read(**ctx.rehearse_kwargs(bindings=bindings))
    assert calls == [] and ctx.scratch.read_bytes() == b"" and list(ctx.out.iterdir()) == []


def test_r2_the_records_are_pinned_and_the_identity_required(ctx: Ctx, tmp_path: Path) -> None:
    calls = _forbid_loaders(ctx.mp)
    kw = ctx.read_kwargs()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    lock2 = elsewhere / "c_lhar_x_1h_finalist_lock.json"
    lock2.write_bytes(Path(kw["lock"]).read_bytes())
    with pytest.raises(ValueError, match="lock record must be"):
        hc.run_read(**{**kw, "lock": str(lock2)})
    art2 = elsewhere / "c_lhar_x_1h_final_model.json"
    art2.write_bytes(ctx.artifact.read_bytes())
    with pytest.raises(ValueError, match="artifact must be"):
        hc.run_read(**{**kw, "artifact": str(art2)})
    rec = json.loads(Path(kw["lock"]).read_text())
    for key in ("finalist", "registry_index", "config_hash"):
        Path(kw["lock"]).write_text(json.dumps({k: v for k, v in rec.items() if k != key}))
        with pytest.raises(ValueError, match=f"lock record's {key}"):
            hc.run_read(**kw)
    assert calls == [] and ctx.real_ledger.read_bytes() == b"" and list(ctx.out.iterdir()) == []


def test_r3_every_d_file_is_contained(env: dict[str, Any], tmp_path: Path) -> None:
    import shutil

    ds = tmp_path / "ds"
    shutil.copytree(env["ds"], ds)
    victim = ds / "perp" / "ETHUSDT" / "5m.jsonl.gz"
    outside = tmp_path / "outside.jsonl.gz"
    outside.write_bytes(victim.read_bytes())
    victim.unlink()
    victim.symlink_to(outside)
    assert data.verify_manifest(ds)[0]
    with pytest.raises(ValueError, match="symlink"):
        hc.load_d(ds, spec=env["spec"])


def _crafted(coin: str, h_start: int, days: int) -> pd.DataFrame:
    """Hourly rows: f low with a daily spike (flag 1 flags the spikes, y follows f), G set per coin for condition 2."""
    n = days * 24
    T = h_start + np.arange(n, dtype=np.int64) * H
    f = np.full(n, 1e-7)
    f[np.arange(n) % 24 == 12] = 4e-6
    g = {
        "BTCUSDT": np.full(n, 0.001),
        "ETHUSDT": np.full(n, 0.01),
        "SOLUSDT": np.where(np.arange(n) % 2 == 0, 0.001, 0.01),
    }
    sd = np.sqrt(f)
    return pd.DataFrame(
        {
            "coin": coin,
            "T": T,
            "y": f.copy(),
            "f": f,
            "persistence": f,
            "ewma": f,
            "R": np.zeros(n),
            "G": g[coin],
            "fold": np.int64(hc.CUTOFF_MS),
            "lo80": -sd,
            "hi80": sd,
            "lo95": -2 * sd,
            "hi95": 2 * sd,
        }
    )[family_c.FORECAST_COLUMNS]


def test_12_forecast_exception_fails_a_flag_that_the_other_coins_would_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    h_start, days = method.H_START, 200
    frames = {c: _crafted(c, h_start, days) for c in COINS3}
    all_rows = pd.concat(list(frames.values()), ignore_index=True)
    without_eth = pd.concat([frames["BTCUSDT"], frames["SOLUSDT"]], ignore_index=True)
    full = family_c.stay_out_flag(all_rows, H, hc.H_SEED_INDEX_ARG)
    rest = family_c.stay_out_flag(without_eth, H, hc.H_SEED_INDEX_ARG)
    assert full["flag2"]["share"] < 0.6 and full["pass"] is False
    assert rest["flag2"]["share"] >= 0.6 and rest["flag1"]["pass"] is True and rest["pass"] is True
    raising: set[str] = set()

    def ff(prep: Any, fits: Any, lo: int, hi: int, **kw: Any) -> tuple[pd.DataFrame, dict[str, Any]]:
        (c,) = kw["coins"]
        if c in raising:
            raise RuntimeError("forecast boom")
        return frames[c], {"skipped": {}}

    monkeypatch.setattr(hc, "prepare_btc", lambda panel, end: (pd.DataFrame(), {}))
    monkeypatch.setattr(hc, "prepare_coin", lambda panel, c, wt, end: {"coin": c})
    monkeypatch.setattr(hc, "forecast_frame", ff)
    monkeypatch.setattr(family_c, "coin_criteria", lambda df, w: {"pass": True, "mean_qlike": 0.1})
    spec = hc.Spec(coins=COINS3, h_start=h_start, h_end=h_start + days * DAY, symbols_min=2)
    records = hc._matching_records(COINS3)
    base, _, _ = hc.evaluate_gated({}, {}, records, spec=spec)
    assert base["verdict"]["pass"] is True and base["stay_out"]["pass"] is False and base["h_pass"] is False
    raising.add("ETHUSDT")
    rec, pool, _ = hc.evaluate_gated({}, {}, records, spec=spec)
    assert set(pool["coin"]) == {"BTCUSDT", "SOLUSDT"}
    assert rec["verdict"]["pass"] is True and rec["stay_out_descriptive"]["pass"] is True
    assert rec["stay_out"]["reason"] == "forecasts undefined" and rec["stay_out"]["coins"] == ["ETHUSDT"]
    assert rec["stay_out"]["flag1_pass"] is False and rec["stay_out"]["flag2_pass"] is False
    assert rec["h_pass"] is False
    raising.clear()
    mismatch = [dict(r, match=r["coin"] != "ETHUSDT") for r in records]
    rec_m, _, _ = hc.evaluate_gated({}, {}, mismatch, spec=spec)
    assert rec_m["stay_out"]["reason"] == "forecasts undefined" and rec_m["h_pass"] is False


def test_r4_the_verdict_line_prints_the_gated_flags(ctx: Ctx, capsys: pytest.CaptureFixture[str]) -> None:
    real = hc.evaluate_gated
    seen: list[int] = []

    def gated(*a: Any, **k: Any) -> Any:
        rec, pool, preps = real(*a, **k)
        seen.append(1)
        if len(seen) == 2:  # the call after the guarded load: the computed flag passes, the gated one is undefined
            rec["stay_out_descriptive"] = {"pass": True, "flag1": {"pass": True}, "flag2": {"pass": True}}
            rec["forecasts_undefined"] = ["ETHUSDT"]
            rec["stay_out"].update({"reason": "forecasts undefined", "coins": ["ETHUSDT"]})
        return rec, pool, preps

    ctx.mp.setattr(hc, "evaluate_gated", gated)
    hc.run_read(**ctx.rehearse_kwargs())
    line = next(x for x in capsys.readouterr().out.splitlines() if x.startswith("H VERDICT"))
    assert line.endswith("flag1=False flag2=False") and "pass=False" in line
    assert (ctx.out / "verdict.txt").read_text().splitlines()[0] == line


def test_r4_b4_refuses_an_info_mismatch(small: dict[str, Any], bound: dict[str, Any]) -> None:
    prep = {c: dict(p) for c, p in small["prep"].items()}
    prep["SOLUSDT"]["info"] = {**prep["SOLUSDT"]["info"], "n_incomplete": prep["SOLUSDT"]["info"]["n_incomplete"] + 1}
    with pytest.raises(ValueError, match=r"B4 \(SOLUSDT, info\)"):
        hc.bind_d(small["panel"], prep, bound["ref"], bound["fits"], spec=bound["spec"], full=False)


def test_c1_a_stdout_failure_after_the_first_load_changes_nothing(ctx: Ctx, capsys: pytest.CaptureFixture[str]) -> None:
    real_log = hc._log

    def log(message: str) -> None:
        if message.startswith("H VERDICT"):
            raise BrokenPipeError("stdout closed")
        real_log(message)

    ctx.mp.setattr(hc, "_log", log)
    res = hc.run_read(**ctx.rehearse_kwargs())
    capsys.readouterr()
    lines = (ctx.out / "verdict.txt").read_text().splitlines()
    assert lines[0].startswith("H VERDICT") and lines[1].startswith("H RECORD")
    assert json.loads(lines[1].removeprefix("H RECORD "))["h_pass"] == res["h_pass"]
    assert (ctx.out / "h_report.json").is_file() and (ctx.out / "receipt.json").is_file()
    assert res["write_failures"] == []
    receipt = json.loads((ctx.out / "receipt.json").read_text())
    assert (
        receipt["outputs_sha256"]["verdict.txt"] == hashlib.sha256((ctx.out / "verdict.txt").read_bytes()).hexdigest()
    )


@pytest.mark.parametrize("error", [BrokenPipeError("pipe"), OSError("io"), ValueError("closed file")])
def test_c1_every_log_after_the_first_load_may_fail(
    ctx: Ctx, capsys: pytest.CaptureFixture[str], error: Exception
) -> None:
    real_log = hc._log
    state = {"loaded": False}

    def log(message: str) -> None:
        if message.startswith("PRELOAD OK"):
            state["loaded"] = True
            real_log(message)
            return
        if state["loaded"]:
            raise error
        real_log(message)

    ctx.mp.setattr(hc, "_log", log)
    ctx.mp.setattr(pd.DataFrame, "to_parquet", lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    res = hc.run_read(**ctx.rehearse_kwargs())
    capsys.readouterr()
    assert (ctx.out / "verdict.txt").is_file() and (ctx.out / "h_report.json").is_file()
    assert len(res["write_failures"]) == 1 and "h_forecasts.parquet" in res["write_failures"][0]


def test_c1_a_failed_verdict_write_does_not_stop_the_report(ctx: Ctx, capsys: pytest.CaptureFixture[str]) -> None:
    real = hc._write_bytes

    def flaky(path: Path, raw: bytes) -> None:
        if path.name == "verdict.txt":
            raise OSError("verdict boom")
        real(path, raw)

    ctx.mp.setattr(hc, "_write_bytes", flaky)
    res = hc.run_read(**ctx.rehearse_kwargs())
    log = capsys.readouterr().out
    assert "H VERDICT" in log and "WRITE FAILED verdict.txt" in log
    assert (ctx.out / "h_report.json").is_file() and (ctx.out / "receipt.json").is_file()
    assert len(res["write_failures"]) == 1 and not (ctx.out / "verdict.txt").exists()


def test_c2_contained_refuses_dots_relative_paths_and_traversal_through_a_link(tmp_path: Path) -> None:
    root = tmp_path / "root"
    (root / "sub").mkdir(parents=True)
    (root / "sub" / "f.txt").write_text("x")
    other = tmp_path / "other"
    (other / "deep").mkdir(parents=True)
    (tmp_path / "link").symlink_to(other / "deep")
    assert hc.contained(root / "sub" / "f.txt", root, "file") == str(root / "sub" / "f.txt")
    # normpath(link/../root/sub/f.txt) is a real file under root, the OS path walks through the link to other/
    through_link = f"{tmp_path}/link/../root/sub/f.txt"
    assert os.path.normpath(through_link) == str(root / "sub" / "f.txt")
    for bad in (
        through_link,
        f"{root}/sub/../sub/f.txt",
        f"{root}/./sub/f.txt",
        "root/sub/f.txt",
        f"{root}//sub/f.txt",
        f"{root}/sub/f.txt/",
    ):
        with pytest.raises(ValueError):
            hc.contained(bad, root, "file")
    with pytest.raises(ValueError, match="component"):
        hc.contained(f"{root}/sub/../sub", root, "dir")
    with pytest.raises(ValueError, match="not absolute"):
        hc.contained("root/sub", root, "dir")


def test_c2_run_read_refuses_traversal_before_any_loader_call(ctx: Ctx) -> None:
    calls = _forbid_loaders(ctx.mp)
    sub = ctx.tmp / "other" / "sub"
    sub.mkdir(parents=True)
    (ctx.tmp / "other" / "ledger.jsonl").write_bytes(b"")
    (ctx.scratch.parent / "link").symlink_to(sub)
    via_link = f"{ctx.scratch.parent}/link/../ledger.jsonl"
    assert os.path.normpath(via_link) == str(ctx.scratch)
    rel_ds = os.path.relpath(ctx.env["ds"])
    for over in (
        {"ledger": via_link},
        {"h": f"{ctx.h_dir}/perp/.."},
        {"ds": f"{ctx.env['ds']}/."},
        {"ds": rel_ds},
        {"out": f"{ctx.out}/../out"},
        {"artifact": f"{ctx.tmp}/x/../artifact.json"},
    ):
        with pytest.raises(ValueError):
            hc.run_read(**ctx.rehearse_kwargs(**over))
    kw = ctx.read_kwargs()
    for over in (
        {"lock": f"{ctx.tmp}/x/../lock.json"},
        {"ledger": f"{ctx.real_ledger.parent}/../real/{ctx.real_ledger.name}"},
    ):
        with pytest.raises(ValueError):
            hc.run_read(**{**kw, **over})
    assert calls == [] and ctx.scratch.read_bytes() == b"" and ctx.real_ledger.read_bytes() == b""
    assert list(ctx.out.iterdir()) == []


def test_c3_run_read_refuses_a_replaced_spec_before_any_loader_call(ctx: Ctx) -> None:
    calls = _forbid_loaders(ctx.mp)
    spec = ctx.env["spec"]
    shifted = replace(spec, symbols_min=7, h_seed=spec.h_seed + 1, h_seed_index_arg=spec.h_seed_index_arg + 1)
    ctx.mp.setattr(hc, "SPEC", shifted)
    with pytest.raises(ValueError, match="SPEC differs"):
        hc.run_read(**ctx.rehearse_kwargs())
    with pytest.raises(ValueError, match="SPEC differs"):
        hc.run_read(**ctx.read_kwargs())
    assert calls == [] and ctx.scratch.read_bytes() == b"" and ctx.real_ledger.read_bytes() == b""
    assert list(ctx.out.iterdir()) == []


def test_c3_the_locked_spec_equals_the_module_constants(monkeypatch: pytest.MonkeyPatch) -> None:
    hc.check_spec(hc.Spec())
    hc.check_spec(hc.SPEC)
    base = hc.Spec()
    assert base.coins == method.UNIVERSE and base.symbols_min is None and base.cutoff_ms == hc.CUTOFF_MS
    for change in (
        {"coins": method.UNIVERSE[::-1]},
        {"coins": method.UNIVERSE[:9]},
        {"symbols_min": 7},
        {"cutoff_ms": hc.CUTOFF_MS + H},
        {"lookback_months": 23},
        {"min_train": hc.MIN_TRAIN - 1},
        {"h_seed": hc.H_SEED + 1},
        {"h_seed_index_arg": hc.H_SEED_INDEX_ARG + 1},
        {"d_dataset_hash": "0" * 64},
        {"h_start": method.H_START + 1},
    ):
        with pytest.raises(ValueError, match="SPEC differs"):
            hc.check_spec(replace(base, **change))
    # main refuses every subcommand under a replaced SPEC and never reaches the entry points
    reached: list[str] = []
    monkeypatch.setattr(hc, "run_read", lambda **kw: reached.append("read"))
    monkeypatch.setattr(hc, "run_artifact", lambda *a: reached.append("artifact"))
    monkeypatch.setattr(hc, "SPEC", replace(base, symbols_min=7, h_seed=hc.H_SEED + 1))
    base_args = ["--ds", "/ds", "--h", "/h", "--ref", "/r", "--artifact", "/a", "--read-id", "a" * 40, "--commit"]
    with pytest.raises(ValueError, match="SPEC differs"):
        hc.main(["read", *base_args, "a" * 40, "--ledger", "/l", "--out", "/o", "--lock", "/k"])
    with pytest.raises(ValueError, match="SPEC differs"):
        hc.main(["artifact", "--ds", "/d", "--ref", "/r", "--out", "/o", "--commit", "abc1234", "--reproduction", "/p"])
    assert reached == []


def test_rec1_span_falls_back_and_counts_as_a_mismatch() -> None:
    frame = pd.DataFrame({"t": pd.Series([1, "x", 3], dtype=object)})
    assert hc._span(frame) == (3, None, None)
    entry = {"rowCount": 3, "startMs": 1, "endMs": 3}
    assert hc._matches(*hc._span(frame), entry) is False
    assert hc._matches(3, 1, 3, entry) is True and hc._matches(*hc._span(pd.DataFrame()), entry) is False
    assert hc._matches(3, None, None, {"rowCount": 3, "startMs": None, "endMs": None}) is False


def test_rec2_err_falls_back_to_the_type_name() -> None:
    class Odd(Exception):
        def __str__(self) -> str:
            raise RuntimeError("no text")

    assert hc._err(Odd()) == "Odd" and hc._err(ValueError("a")) == "ValueError: a"


def test_rec4_the_dry_run_binds_the_seed_of_the_gated_path(ctx: Ctx) -> None:
    fits = hc.parse_model(json.loads(ctx.env["artifact_bytes"])["model"], coins=COINS4)
    spec = ctx.env["spec"]
    assert hc.dry_run(fits, spec=spec)["coins"] == list(COINS4)
    real = hc.evaluate_gated

    def gated(*a: Any, **k: Any) -> Any:
        rec, pool, preps = real(*a, **k)
        rec["stay_out"]["flag1"] = {**rec["stay_out"]["flag1"], "seed": spec.h_seed + 1}
        return rec, pool, preps

    ctx.mp.setattr(hc, "evaluate_gated", gated)
    with pytest.raises(ValueError, match="seed"):
        hc.dry_run(fits, spec=spec)


def test_rec6_b2_runs_through_per_coin_forecast_frame_calls(small: dict[str, Any], bound: dict[str, Any]) -> None:
    real = hc.forecast_frame
    seen: list[tuple[str, ...]] = []

    def spy(prep: Any, fits: Any, lo: int, hi: int, **kw: Any) -> Any:
        seen.append(tuple(kw["coins"]))
        assert tuple(prep) == tuple(kw["coins"])
        return real(prep, fits, lo, hi, **kw)

    mp = pytest.MonkeyPatch()
    try:
        mp.setattr(hc, "forecast_frame", spy)
        hc.bind_d(small["panel"], small["prep"], bound["ref"], bound["fits"], spec=bound["spec"], full=False)
    finally:
        mp.undo()
    assert seen == [(c,) for c in COINS3]


def test_rec7_the_artifact_run_compares_the_d_manifest_spans(
    env: dict[str, Any], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import shutil

    record = json.loads((env["art_out"] / "binding.json").read_text())["D_manifest"]
    assert (
        record["all_match"] and len(record["records"]) == 2 * len(COINS4) and record["files"] == len(record["records"])
    )
    assert {r["path"] for r in record["records"]} == {
        t.format(c=c) for c in COINS4 for t in ("perp/{c}/5m.jsonl.gz", "perp/{c}/5m.premiumIndex.jsonl.gz")
    }
    monkeypatch.setattr(hc, "SPEC", env["spec"])
    monkeypatch.setattr(cli, "reproduction_inputs", _good_repro)
    for field, delta, path in (
        ("rowCount", 1, "perp/ETHUSDT/5m.jsonl.gz"),
        ("startMs", BAR, "perp/SOLUSDT/5m.premiumIndex.jsonl.gz"),
        ("endMs", -BAR, "perp/BTCUSDT/5m.jsonl.gz"),
    ):
        ds = tmp_path / f"ds-{field}"
        shutil.copytree(env["ds"], ds)
        _edit_manifest(
            ds,
            path,
            **{
                field: next(f for f in json.loads((ds / "manifest.json").read_text())["files"] if f["path"] == path)[
                    field
                ]
                + delta
            },
        )
        out = tmp_path / f"out-{field}"
        out.mkdir()
        with pytest.raises(ValueError, match=f"D manifest spans differ.*{path}"):
            hc.run_artifact(str(ds), str(env["ref"]), str(out), "c" * 40, str(env["reproduction"]))
        assert list(out.iterdir()) == []
    # a manifest without the exporter's fields differs as well
    ds = tmp_path / "ds-bare"
    shutil.copytree(env["ds"], ds)
    _edit_manifest(ds, "perp/XRPUSDT/5m.jsonl.gz", rowCount=None, startMs=None, endMs=None)
    out = tmp_path / "out-bare"
    out.mkdir()
    with pytest.raises(ValueError, match="D manifest spans differ"):
        hc.run_artifact(str(ds), str(env["ref"]), str(out), "c" * 40, str(env["reproduction"]))


def test_rec9_the_h_manifest_needs_exactly_the_expected_entries(env: dict[str, Any], tmp_path: Path) -> None:
    import shutil

    kw = {"coins": COINS4}
    good = hc.check_h_manifest(env["h_dir"], env["h_hash"], env["h_table"], **kw)
    assert len(good["files"]) == 3 * len(COINS4)
    with pytest.raises(ValueError, match="bound file table"):
        hc.check_h_manifest(env["h_dir"], env["h_hash"], [*env["h_table"], env["h_table"][0]], **kw)
    root = tmp_path / "h-dup"
    shutil.copytree(env["h_dir"], root)
    manifest = json.loads((root / "manifest.json").read_text())
    manifest["files"].append(dict(manifest["files"][0]))
    manifest["datasetHash"] = data.dataset_hash_of(manifest["files"])
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True))
    assert data.verify_manifest(root)[0]
    with pytest.raises(ValueError, match="13 entries, 12 distinct"):
        hc.check_h_manifest(root, manifest["datasetHash"], None, **kw)
