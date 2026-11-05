"""Brief 34a: family D core (Amendment 6): the f input, weights, band and the extension branches. Synthetic only."""

from __future__ import annotations

import hashlib
import json
import struct
from typing import Any

import numpy as np
import pandas as pd
import pytest

from r4 import calibration, cli, family_a, family_c, family_d
from r4.book import netted_costs
from r4.causality import assert_future_invariant
from r4.method import DEV_END, ENTRY_DELAY_MS
from r4.pipeline import RunConfig, _make_tranches, decision_samples, rank_weights, run_config_from_raw
from r4.synth import synth_panel
from tests.test_cli_bar import _create_synthetic_dataset_dir, _make_fast_synthetic_panel

H = 3_600_000
DAY = 86_400_000
BAR = 300_000
T0 = 1_700_000_000_000 // H * H
COMMIT = "c" * 40


# ---------------------------------------------------------------------------------------------------------------------
# Weights (A6.1)
# ---------------------------------------------------------------------------------------------------------------------


def _times(n_times: int, n_coins: int) -> np.ndarray:
    return np.repeat(T0 + np.arange(n_times, dtype=np.int64) * H, n_coins)


def test_inv_vol_weights_are_neutral_and_gross_one_with_sides_from_centred_ranks() -> None:
    rng = np.random.default_rng(1)
    for n_coins in (6, 7, 10):
        times = _times(40, n_coins)
        scores = rng.normal(size=len(times))
        f = rng.uniform(1e-5, 1e-3, size=len(times))
        w = family_d.inv_vol_weights(times, scores, f)
        for t in np.unique(times):
            m = times == t
            assert abs(np.abs(w[m]).sum() - 1.0) < 1e-12
            assert abs(w[m].sum()) < 1e-12
            ranks = pd.Series(scores[m]).rank(method="average").to_numpy()
            centred = ranks - (n_coins + 1) / 2.0
            assert np.array_equal(np.sign(w[m]), np.sign(centred))
            assert abs(w[m][w[m] > 0].sum() - 0.5) < 1e-12 and abs(w[m][w[m] < 0].sum() + 0.5) < 1e-12


def test_inv_vol_cash_cases() -> None:
    t5 = np.full(5, T0)
    assert not family_d.inv_vol_weights(t5, np.arange(5.0), np.ones(5)).any()
    t6 = np.full(6, T0)
    scores = np.arange(6.0)
    assert family_d.inv_vol_weights(t6, scores, np.ones(6)).any()
    # all scores tied
    assert not family_d.inv_vol_weights(t6, np.ones(6), np.ones(6)).any()
    # a non-positive or missing f drops a coin: 6 coins become 5 and the time is cash
    for bad in (0.0, -1.0, np.nan, np.inf):
        f = np.ones(6)
        f[2] = bad
        w = family_d.inv_vol_weights(t6, scores, f)
        if np.isinf(bad):
            # an infinite f is not finite: unranked
            assert not w.any()
        else:
            assert not w.any()
    # a missing score does the same
    s = scores.copy()
    s[0] = np.nan
    assert not family_d.inv_vol_weights(t6, s, np.ones(6)).any()
    # 7 coins, one unranked: still 6 ranked, the unranked coin gets exactly 0
    t7 = np.full(7, T0)
    f7 = np.ones(7)
    f7[3] = np.nan
    w7 = family_d.inv_vol_weights(t7, np.arange(7.0), f7)
    assert w7[3] == 0.0 and abs(np.abs(w7).sum() - 1.0) < 1e-12


def test_inv_vol_magnitudes_may_break_rank_order() -> None:
    times = np.full(6, T0)
    scores = np.array([0.0, 1.0, 2.0, 3.0, 4.0, 5.0])
    # the top-ranked coin (c = 2.5) has a huge sigma, the second (c = 1.5) a tiny one
    f = np.array([1.0, 1.0, 1.0, 1.0, 1e-4, 100.0])
    w = family_d.inv_vol_weights(times, scores, f)
    assert w[5] > 0 and w[4] > 0 and w[4] > w[5]
    assert abs(np.abs(w).sum() - 1.0) < 1e-12 and abs(w.sum()) < 1e-12


def test_inv_vol_with_equal_f_equals_rank_weights_bit_for_bit() -> None:
    rng = np.random.default_rng(2)
    for n_coins in (6, 7, 10):
        times = _times(30, n_coins)
        scores = rng.normal(size=len(times))
        ties = np.round(scores, 1)  # ties as well
        for sc in (scores, ties):
            for fv in (1.0, 4.0):
                got = family_d.inv_vol_weights(times, sc, np.full(len(sc), fv))
                assert np.array_equal(got, rank_weights(times, sc))


def test_book_weights_rank_band_zero_equals_rank_weights() -> None:
    rng = np.random.default_rng(3)
    times = _times(25, 8)
    scores = rng.normal(size=len(times))
    symbols = np.array([f"C{i}USDT" for i in range(8)] * 25)
    got = family_d.book_weights(times, symbols, scores, None, "rank", 0.0, 4 * H, H)
    assert np.array_equal(got, rank_weights(times, scores))
    f = rng.uniform(1e-5, 1e-3, size=len(times))
    inv = family_d.book_weights(times, symbols, scores, f, "inv_vol", 0.0, 4 * H, H)
    assert np.array_equal(inv, family_d.inv_vol_weights(times, scores, f))
    with pytest.raises(ValueError, match="needs f"):
        family_d.book_weights(times, symbols, scores, None, "inv_vol", 0.0, 4 * H, H)


# ---------------------------------------------------------------------------------------------------------------------
# The band (A6.3)
# ---------------------------------------------------------------------------------------------------------------------

SYMS6 = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "ADAUSDT", "DOGEUSDT"]


def _block(score_rows: list[list[float]], gap: int = 2, f_rows: list[list[float]] | None = None):
    """Decision times T0, T0 + gap h, ... with one row per coin per time."""
    n_c = len(score_rows[0])
    times = np.repeat([T0 + k * gap * H for k in range(len(score_rows))], n_c).astype(np.int64)
    symbols = np.array(SYMS6[:n_c] * len(score_rows))
    scores = np.array(score_rows, dtype=np.float64).ravel()
    f = None if f_rows is None else np.array(f_rows, dtype=np.float64).ravel()
    return times, symbols, scores, f


BASE = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0]


def test_band_repeat_within_b_and_no_repeat_beyond_b() -> None:
    near = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0]  # identical ranks: w_new == w_prev
    swapped = [1.0, 0.0, 2.0, 3.0, 4.0, 5.0, 6.0]  # the two lowest swap: weights move by 1/12 = 0.0833
    times, symbols, scores, _ = _block([BASE, near, swapped], gap=2)
    w_new = rank_weights(times, scores)
    # h = 2 decision gaps of 2h: T - h is the previous decision
    taken = family_d.book_weights(times, symbols, scores, None, "rank", 0.09, 2 * H, H)
    first, second, third = taken[:7], taken[7:14], taken[14:]
    assert np.array_equal(first, w_new[:7])  # block start: no w_prev
    assert np.array_equal(second, first)
    move = np.abs(w_new[14:] - second).max()
    assert 0.0 < move <= 0.09
    assert np.array_equal(third, second)  # within b: w_prev is taken again
    # beyond b the new target is taken
    tight = family_d.book_weights(times, symbols, scores, None, "rank", 0.05, 2 * H, H)
    assert np.array_equal(tight[14:], w_new[14:])
    # b = 0 never repeats (here the first repeat is a coincidence of equal targets, the third moves)
    none = family_d.book_weights(times, symbols, scores, None, "rank", 0.0, 2 * H, H)
    assert np.array_equal(none, w_new)


def test_band_boundary_is_inclusive() -> None:
    swapped = [1.0, 0.0, 2.0, 3.0, 4.0, 5.0, 6.0]
    times, symbols, scores, _ = _block([BASE, swapped], gap=2)
    w_new = rank_weights(times, scores)
    move = float(np.abs(w_new[7:] - w_new[:7]).max())
    at = family_d.book_weights(times, symbols, scores, None, "rank", move, 2 * H, H)
    assert np.array_equal(at[7:], at[:7])
    below = family_d.book_weights(times, symbols, scores, None, "rank", move * 0.999, 2 * H, H)
    assert np.array_equal(below[7:], w_new[7:])


def test_band_coin_set_change_takes_new() -> None:
    # the second decision ranks 6 coins (one f is missing): a different ranked set, even though the other ranks match
    f = [[1.0] * 7, [np.nan] + [1.0] * 6]
    times, symbols, scores, fv = _block([BASE, BASE], gap=2, f_rows=f)
    taken = family_d.book_weights(times, symbols, scores, fv, "inv_vol", 0.5, 2 * H, H)
    assert taken[7] == 0.0 and abs(np.abs(taken[7:]).sum() - 1.0) < 1e-12
    assert np.array_equal(taken[7:], family_d.inv_vol_weights(times, scores, fv)[7:])
    # the same f at both times repeats under the same band
    f_same = [[1.0] * 7, [1.0] * 7]
    times, symbols, scores, fv = _block([BASE, BASE], gap=2, f_rows=f_same)
    taken = family_d.book_weights(times, symbols, scores, fv, "inv_vol", 0.5, 2 * H, H)
    assert np.array_equal(taken[7:], taken[:7])
    # a zero-weight median coin is ranked: a missing median f changes the set
    f_med = [[1.0] * 7, [1.0, 1.0, 1.0, np.nan, 1.0, 1.0, 1.0]]
    times, symbols, scores, fv = _block([BASE, BASE], gap=2, f_rows=f_med)
    taken = family_d.book_weights(times, symbols, scores, fv, "inv_vol", 0.5, 2 * H, H)
    assert not np.array_equal(taken[7:], taken[:7])


def test_band_block_start_and_not_in_block() -> None:
    # decisions every 1h, h = 2h: the first two decisions have T - h before the block and take w_new
    rows = [BASE, BASE, BASE, BASE]
    times, symbols, scores, _ = _block(rows, gap=1)
    taken = family_d.book_weights(times, symbols, scores, None, "rank", 0.09, 2 * H, H)
    w = rank_weights(times, scores)
    assert np.array_equal(taken, w)  # identical targets, so the result is the same either way
    # make the first two targets differ from the third and fourth by a move inside b
    swapped = [1.0, 0.0, 2.0, 3.0, 4.0, 5.0, 6.0]
    times, symbols, scores, _ = _block([BASE, swapped, BASE, swapped], gap=1)
    w = rank_weights(times, scores)
    taken = family_d.book_weights(times, symbols, scores, None, "rank", 0.09, 2 * H, H)
    assert np.array_equal(taken[:7], w[:7]) and np.array_equal(taken[7:14], w[7:14])  # unbanded block start
    assert np.array_equal(taken[14:21], taken[:7])  # T - h is decision 0
    assert np.array_equal(taken[21:], taken[7:14])  # T - h is decision 1


def test_band_cash_at_t_minus_h_takes_new() -> None:
    cash_row = [3.0] * 7  # all tied
    times, symbols, scores, _ = _block([cash_row, BASE], gap=2)
    taken = family_d.book_weights(times, symbols, scores, None, "rank", 0.09, 2 * H, H)
    assert not taken[:7].any()
    assert np.array_equal(taken[7:], rank_weights(times, scores)[7:])


def test_band_state_chains_through_taken_weights() -> None:
    # three decisions h apart, each move inside b of the previous w_new but the sum of moves beyond b: the band
    # compares with the taken target, so decision 2 compares with the taken decision 1 (= decision 0)
    a = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0]
    b = [1.0, 0.0, 2.0, 3.0, 4.0, 5.0, 6.0]
    times, symbols, scores, _ = _block([a, b, a], gap=2)
    taken = family_d.book_weights(times, symbols, scores, None, "rank", 0.09, 2 * H, H)
    assert np.array_equal(taken[7:14], taken[:7]) and np.array_equal(taken[14:], taken[:7])


def test_band_with_inv_vol_uses_f() -> None:
    f = [[1.0] * 7, [1.0] * 6 + [1.0000001], [1.0] * 7]
    times, symbols, scores, fv = _block([BASE, BASE, BASE], gap=2, f_rows=f)
    taken = family_d.book_weights(times, symbols, scores, fv, "inv_vol", 0.01, 2 * H, H)
    assert np.array_equal(taken[7:14], taken[:7]) and np.array_equal(taken[14:], taken[:7])


def _tranche_cfg(**over: Any) -> RunConfig:
    base: dict[str, Any] = {
        "family": "D",
        "model": "ridge",
        "params": {"alpha": 1.0},
        "features": ("ret_1",),
        "interval": "1h",
        "h_ms": 2 * H,
        "label": "fixed",
        "side_rule": "sign",
        "threshold": 0.0,
        "size_rule": "unit",
        "lookback_months": None,
        "refit": "monthly",
        "exit": "horizon",
        "seed": 7,
        "book": "D",
    }
    base.update(over)
    return RunConfig(**base)


def _test_df(times: np.ndarray, symbols: np.ndarray, h_ms: int, d_f: np.ndarray | None = None) -> pd.DataFrame:
    df = pd.DataFrame(
        {
            "symbol": symbols,
            "T": times,
            "entry": 100.0,
            "exit": 101.0,
            "t0": times,
            "t1_max": times + ENTRY_DELAY_MS + h_ms,
        }
    )
    if d_f is not None:
        df["d_f"] = d_f
    return df


def test_banded_fills_net_to_exactly_zero() -> None:
    swapped = [1.0, 0.0, 2.0, 3.0, 4.0, 5.0, 6.0]
    times, symbols, scores, _ = _block([BASE, swapped], gap=2)
    cfg = _tranche_cfg(d_band=0.09)
    tranches = _make_tranches(_test_df(times, symbols, cfg.h_ms), scores, cfg)
    handoff = T0 + 2 * H + ENTRY_DELAY_MS
    at = [t for t in tranches if t.exit_ms == handoff or t.entry_ms == handoff]
    assert len(at) == 12  # six non-flat coins expire and six open (the zero-weight median coin has no tranche)
    nc = netted_costs(tranches)
    g = nc.groups
    handoff_groups = g[g["instant_ms"] == handoff]
    assert len(handoff_groups) == 6
    assert (handoff_groups["traded"].to_numpy() == 0.0).all()
    assert (handoff_groups["fee"].to_numpy() == 0.0).all() and (handoff_groups["slippage"].to_numpy() == 0.0).all()
    # without the band the swapped coins trade
    plain = _make_tranches(_test_df(times, symbols, cfg.h_ms), scores, _tranche_cfg())
    gp = netted_costs(plain).groups
    assert (gp[gp["instant_ms"] == handoff]["traded"].to_numpy() > 0.0).any()


# ---------------------------------------------------------------------------------------------------------------------
# The recorder
# ---------------------------------------------------------------------------------------------------------------------


def test_recorder_rows_and_phase() -> None:
    swapped = [1.0, 0.0, 2.0, 3.0, 4.0, 5.0, 6.0]
    times, symbols, scores, _ = _block([BASE, swapped], gap=2)
    # inactive by default
    family_d.book_weights(times, symbols, scores, None, "rank", 0.09, 2 * H, H)
    with family_d.recording() as rec:
        family_d.set_phase("wf")
        family_d.book_weights(times, symbols, scores, None, "rank", 0.09, 2 * H, H)
        family_d.set_phase("cpcv")
        family_d.book_weights(times, symbols, scores, None, "rank", 0.0, 2 * H, H)
    df = rec.frame()
    assert list(df.columns) == family_d.DECISION_COLUMNS
    assert len(df) == 28 and set(df["phase"]) == {"wf", "cpcv"}
    wf = df[df["phase"] == "wf"]
    assert list(wf["call"].unique()) == [0] and list(df[df["phase"] == "cpcv"]["call"].unique()) == [1]
    assert (wf["block_start"] == T0).all()
    assert wf["took_prev"].tolist() == [False] * 7 + [True] * 7
    assert not wf["cash"].any() and wf["ranked"].all()
    with pytest.raises(RuntimeError):
        family_d.set_phase("wf")
    assert list(family_d.Recorder().frame().columns) == family_d.DECISION_COLUMNS


# ---------------------------------------------------------------------------------------------------------------------
# The canonical digest
# ---------------------------------------------------------------------------------------------------------------------

DIGEST_VECTOR = "f9ac5198b29d48658401248308424d868d48af3548907714a1c7b64a1b1cc5f9"


def test_canonical_digest_test_vector() -> None:
    df = pd.DataFrame(
        {
            "coin": ["BTCUSDT", "BTCUSDT", "AAVEUSDT", "BTCUSDT", "ETHUSDT"],
            "T": [H, 0, 7, 2 * H, 5],
            "f": [1.5, 2.25, 0.5, np.nan, np.inf],
        }
    )
    want = hashlib.sha256()
    want.update(b"AAVEUSDT\x00" + (7).to_bytes(8, "little", signed=True) + struct.pack("<d", 0.5))
    want.update(b"BTCUSDT\x00" + (0).to_bytes(8, "little", signed=True) + struct.pack("<d", 2.25))
    want.update(b"BTCUSDT\x00" + (H).to_bytes(8, "little", signed=True) + struct.pack("<d", 1.5))
    assert want.hexdigest() == DIGEST_VECTOR
    assert family_d.canonical_digest(df, "f") == DIGEST_VECTOR
    # row order does not matter, a non-finite row does not count
    assert family_d.canonical_digest(df.iloc[::-1], "f") == DIGEST_VECTOR


# ---------------------------------------------------------------------------------------------------------------------
# The full-grid f and the parity check
# ---------------------------------------------------------------------------------------------------------------------


def _small_finalist(first_day: int = 40, end_day: int = 70) -> dict[str, Any]:
    by_id = {c["id"]: c for c in family_c.family_c()}
    return dict(
        by_id[family_d.FINALIST_ID],
        first_refit_ms=first_day * DAY,
        min_train_windows=100,
        partition_end_ms=end_day * DAY,
    )


@pytest.fixture(scope="module")
def synth_clean() -> dict[str, dict[str, pd.DataFrame]]:
    panel = synth_panel(np.array([[0.0016, 0.0008], [0.0008, 0.0025]]), ["BTCUSDT", "ETHUSDT"], 0, 70 * DAY, seed=9)
    rng = np.random.default_rng(1)
    for s in panel:
        d = panel[s]
        prem = d["premium_5m"].assign(c=rng.normal(0, 1e-3, size=len(d["premium_5m"])))
        fund = d["settlements"].assign(rate=rng.normal(1e-4, 5e-5, size=len(d["settlements"])))
        panel[s] = {**d, "premium_5m": prem, "premiumIndex": prem, "settlements": fund, "funding": fund}
    return panel


@pytest.fixture(scope="module")
def synth_two(synth_clean: dict[str, dict[str, pd.DataFrame]]) -> dict[str, dict[str, pd.DataFrame]]:
    """The clean panel with one zero-volume 5m bar of ETH inside the hour starting at day 55 + 2h."""
    panel = dict(synth_clean)
    eth = panel["ETHUSDT"]["5m"].copy()
    zero_hour = 55 * DAY + 2 * H
    eth.loc[eth["t"] == zero_hour + 3 * BAR, "v"] = 0.0
    panel["ETHUSDT"] = {**panel["ETHUSDT"], "5m": eth}
    return panel


def test_full_grid_equals_compute_forecasts_bit_for_bit(synth_two: dict[str, dict[str, pd.DataFrame]]) -> None:
    fin = _small_finalist()
    full = family_d.full_grid_forecasts(synth_two, fin)
    fc, _ = family_c.compute_forecasts(synth_two, fin)
    rows = fc[np.isfinite(fc["f"])]
    assert len(rows) > 500
    merged = rows[["coin", "T", "f"]].merge(full, on=["coin", "T"], how="left", suffixes=("", "_full"))
    assert len(merged) == len(rows)
    assert np.array_equal(merged["f"].to_numpy(), merged["f_full"].to_numpy())
    assert family_d.canonical_digest(rows, "f") == family_d.canonical_digest(
        full.merge(rows[["coin", "T"]], on=["coin", "T"]), "f"
    )


def test_full_grid_covers_incomplete_windows_and_leaves_pre_refit_nan(
    synth_two: dict[str, dict[str, pd.DataFrame]],
) -> None:
    fin = _small_finalist()
    full = family_d.full_grid_forecasts(synth_two, fin)
    fc, _ = family_c.compute_forecasts(synth_two, fin)
    eth = full[full["coin"] == "ETHUSDT"].set_index("T")["f"]
    zero_t = 55 * DAY + 2 * H
    assert np.isfinite(eth.loc[zero_t]) and eth.loc[zero_t] > 0
    cf = fc[(fc["coin"] == "ETHUSDT") & (fc["T"] == zero_t)]
    assert len(cf) == 0 or not np.isfinite(cf["f"]).any()
    # compute_forecasts has a row only where the window is complete: the zero-volume hour has none
    assert zero_t not in set(fc.loc[(fc["coin"] == "ETHUSDT") & fc["y"].notna(), "T"])
    # before the first refit nothing is forecast
    assert eth.loc[: 40 * DAY - H].isna().all()
    assert eth.index.min() == 0 and eth.index.max() == 70 * DAY - H
    # a hole in the grid: after the zero-volume window the 30d components are missing
    assert eth.loc[zero_t + 2 * H : zero_t + 5 * H].isna().all()


def test_check_parity(synth_two: dict[str, dict[str, pd.DataFrame]], monkeypatch: pytest.MonkeyPatch) -> None:
    fin = _small_finalist()
    full = family_d.full_grid_forecasts(synth_two, fin)
    fc, _ = family_c.compute_forecasts(synth_two, fin)
    rows = fc[np.isfinite(fc["f"])]
    digest = family_d.canonical_digest(rows, "f")
    monkeypatch.setitem(family_d.PARITY_REFERENCE, "ds-hash", digest)
    res = family_d.check_parity(synth_two, "ds-hash", full, fin)
    assert res["parity_digest"] == digest and res["parity_rows"] == len(rows)
    assert res["full_grid_digest"] == family_d.canonical_digest(full, "f")
    assert res["full_grid_rows"] == int(np.isfinite(full["f"]).sum())
    assert set(res["missing_wf_hours_by_coin"]) == {"BTCUSDT", "ETHUSDT"}
    eth_missing = int(
        full[(full["coin"] == "ETHUSDT") & (full["T"] >= 40 * DAY) & (full["T"] <= 70 * DAY - H)]["f"].isna().sum()
    )
    assert res["missing_wf_hours_by_coin"]["ETHUSDT"] == eth_missing and eth_missing > 0
    monkeypatch.setitem(family_d.PARITY_REFERENCE, "ds-hash", "0" * 64)
    with pytest.raises(ValueError, match="digest"):
        family_d.check_parity(synth_two, "ds-hash", full, fin)
    monkeypatch.setitem(family_d.PARITY_REFERENCE, "ds-hash", digest)
    bad = full.copy()
    bad.loc[bad.index[bad["f"].notna()][0], "f"] *= 1.0000000001
    with pytest.raises(ValueError, match="bit-identical"):
        family_d.check_parity(synth_two, "ds-hash", bad, fin)
    with pytest.raises(ValueError, match="no family C parity reference"):
        family_d.check_parity(synth_two, "unknown-hash", full, fin)


def test_full_grid_is_future_invariant(synth_clean: dict[str, dict[str, pd.DataFrame]]) -> None:
    fin = _small_finalist()
    btc = synth_clean["BTCUSDT"]
    eth = synth_clean["ETHUSDT"]
    Ts = [int(45 * DAY + 5 * H), int(52 * DAY + 11 * H), int(63 * DAY + 3 * H)]

    def build(five_btc: pd.DataFrame, five_eth: pd.DataFrame, settle: pd.DataFrame, prem: pd.DataFrame) -> pd.DataFrame:
        panel = {
            "BTCUSDT": {**btc, "5m": five_btc},
            "ETHUSDT": {**eth, "5m": five_eth, "settlements": settle, "premium_5m": prem},
        }
        full = family_d.full_grid_forecasts(panel, fin)
        return full[full["coin"] == "ETHUSDT"].set_index("T")[["f"]]

    base = build(btc["5m"], eth["5m"], eth["settlements"], eth["premium_5m"])
    assert all(np.isfinite(base.loc[T, "f"]) for T in Ts)
    assert_future_invariant(
        build,
        [(btc["5m"], BAR), (eth["5m"], BAR), (eth["settlements"], 0), (eth["premium_5m"], BAR)],
        Ts,
    )


# ---------------------------------------------------------------------------------------------------------------------
# RunConfig, decision_samples and _make_tranches
# ---------------------------------------------------------------------------------------------------------------------


def test_run_config_validation_of_the_two_fields() -> None:
    assert _tranche_cfg().d_weights == "rank" and _tranche_cfg().d_band == 0.0
    ok = _tranche_cfg(d_weights="inv_vol", d_band=0.045)
    assert ok.d_weights == "inv_vol" and ok.d_band == 0.045
    for bad in ({"d_weights": "bogus"}, {"d_band": -0.01}, {"d_band": float("nan")}, {"d_band": float("inf")}):
        with pytest.raises(ValueError):
            _tranche_cfg(**bad)
    with pytest.raises(ValueError):
        _tranche_cfg(d_band=True)
    with pytest.raises(ValueError):
        _tranche_cfg(d_band="0.1")
    # a non-default value needs family D and book D
    with pytest.raises(ValueError, match="family 'D' and book 'D'"):
        _tranche_cfg(family="A", d_weights="inv_vol")
    with pytest.raises(ValueError, match="family 'D' and book 'D'"):
        _tranche_cfg(family="A", d_band=0.045)
    with pytest.raises(ValueError):
        _tranche_cfg(book="slot", d_band=0.045)
    # the defaults stay allowed anywhere
    assert _tranche_cfg(family="A").d_weights == "rank"
    # a band needs E1
    with pytest.raises(ValueError, match="exit E1"):
        _tranche_cfg(d_band=0.045, exit={"rule": "E2", "k": 2.0})
    # inv_vol without a band may use another exit
    assert _tranche_cfg(d_weights="inv_vol", exit={"rule": "E2", "k": 2.0}).d_band == 0.0


def test_run_config_from_raw_defaults_and_fields() -> None:
    raw = dict(family_d.family_d()[1])
    rc = run_config_from_raw(raw)
    assert rc.d_weights == "inv_vol" and rc.d_band == 0.045 and rc.book == "D"
    old = {k: v for k, v in raw.items() if k not in ("d_weights", "d_band")}
    rc0 = run_config_from_raw(old)
    assert rc0.d_weights == "rank" and rc0.d_band == 0.0
    a = family_a.family_a()[0]
    ra = run_config_from_raw(a)
    assert ra.d_weights == "rank" and ra.d_band == 0.0


def test_default_d_config_makes_the_same_tranches_as_rank_weights() -> None:
    rng = np.random.default_rng(5)
    times = _times(12, 8)
    symbols = np.array([f"C{i}USDT" for i in range(8)] * 12)
    scores = rng.normal(size=len(times))
    cfg = _tranche_cfg(interval="1h", h_ms=4 * H)
    got = _make_tranches(_test_df(times, symbols, cfg.h_ms), scores, cfg)
    w = rank_weights(times, scores)
    scale = H / (4 * H)
    want = [
        (symbols[i], 1 if w[i] > 0 else -1, int(times[i]) + ENTRY_DELAY_MS, float(w[i]) * scale)
        for i in range(len(w))
        if w[i] != 0.0
    ]
    assert [(t.symbol, t.side, t.entry_ms, t.weight_override) for t in got] == want
    # the new branch with defaults of the rule (rank) and a zero band is not reached, and a band-0 inv_vol-free call
    # of book_weights gives the same weights
    assert np.array_equal(family_d.book_weights(times, symbols, scores, None, "rank", 0.0, 4 * H, H), w)


def test_inv_vol_tranches_use_d_f_and_need_the_column() -> None:
    times = _times(3, 7)
    symbols = np.array(SYMS6 * 3)
    scores = np.tile(np.arange(7.0), 3)
    f = np.tile(np.array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]) * 1e-4, 3)
    cfg = _tranche_cfg(interval="1h", h_ms=4 * H, d_weights="inv_vol")
    got = _make_tranches(_test_df(times, symbols, cfg.h_ms, d_f=f), scores, cfg)
    w = family_d.inv_vol_weights(times, scores, f)
    assert [t.weight_override for t in got] == [float(x) / 4.0 for x in w if x != 0.0]
    with pytest.raises(KeyError):
        _make_tranches(_test_df(times, symbols, cfg.h_ms), scores, cfg)


def test_decision_samples_merges_d_f_without_dropping_rows() -> None:
    panel = _make_fast_synthetic_panel(symbols=("BTCUSDT", "ETHUSDT"), n_days=20, seed=4)
    rank_cfg = RunConfig(
        **{**_cfg_kwargs(), "features": ("ret_1", "ret_4")},
    )
    base = decision_samples(panel, rank_cfg)
    assert "d_f" not in base.columns
    inv_cfg = RunConfig(**{**_cfg_kwargs(), "features": ("ret_1", "ret_4"), "d_weights": "inv_vol"})
    with pytest.raises(ValueError, match="needs d_forecasts"):
        decision_samples(panel, inv_cfg)
    keys = base[["symbol", "T"]].iloc[::2].rename(columns={"symbol": "coin"})
    keys["f"] = np.arange(len(keys), dtype=np.float64) + 1.0
    out = decision_samples(panel, inv_cfg, d_forecasts=keys)
    assert len(out) == len(base)
    assert out[["symbol", "T"]].equals(base[["symbol", "T"]])
    assert out["d_f"].notna().sum() == len(keys) and out["d_f"].isna().sum() == len(base) - len(keys)
    assert "d_f" not in inv_cfg.features
    dup = pd.concat([keys, keys.iloc[:1]])
    with pytest.raises(ValueError, match="duplicate"):
        decision_samples(panel, inv_cfg, d_forecasts=dup)


def _cfg_kwargs() -> dict[str, Any]:
    return {
        "family": "D",
        "model": "ridge",
        "params": {"alpha": 1.0},
        "features": ("ret_1",),
        "interval": "1h",
        "h_ms": 4 * H,
        "label": "fixed",
        "side_rule": "sign",
        "threshold": 0.0,
        "size_rule": "unit",
        "lookback_months": None,
        "refit": "monthly",
        "exit": "horizon",
        "seed": 7,
        "book": "D",
    }


# ---------------------------------------------------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------------------------------------------------


def test_registry_is_the_nine_declared_configurations() -> None:
    cfgs = family_d.family_d()
    ids = [c["id"] for c in cfgs]
    assert ids == [
        "D_invvol_b0_C2",
        "D_invvol_b045_C2",
        "D_invvol_b09_C2",
        "D_invvol_b0_C4",
        "D_invvol_b045_C4",
        "D_invvol_b09_C4",
        "D_invvol_b0_C5",
        "D_invvol_b045_C5",
        "D_invvol_b09_C5",
    ]
    assert [c["joint_shift_seed"] for c in cfgs] == [13_000_000 + k for k in range(9)]
    assert family_d.CELLS == {k: calibration.CELLS[k] for k in ("C2", "C4", "C5")}
    a_by_id = {c["id"]: c for c in family_a.family_a()}
    for c in cfgs:
        src = a_by_id[f"A_lgbm_{c['cell']}"]
        for key in (
            "model",
            "params",
            "label",
            "threshold",
            "features",
            "interval",
            "h_ms",
            "lookback_months",
            "refit",
            "seed",
            "first_refit_ms",
            "size_rule",
            "side_rule",
            "kind",
        ):
            assert c[key] == src[key], key
        assert c["family"] == "D" and c["book"] == "D" and c["exit"] == "horizon"
        assert c["d_weights"] == "inv_vol" and c["lookback_months"] == 24 and c["refit"] == "monthly"
        assert c["kind"] == "trial" and c["seed"] == 7
        rc = run_config_from_raw(c)
        assert rc.d_weights == "inv_vol" and rc.d_band == c["d_band"]
    assert [c["d_band"] for c in cfgs] == [0.0, 0.045, 0.09] * 3
    # copies, not references
    cfgs[0]["params"]["n_estimators"] = -1
    assert family_d.family_d()[0]["params"] == a_by_id["A_lgbm_C2"]["params"]
    assert len({cli.config_hash_of(c) for c in cfgs}) == 9


def test_twin_fields_and_seeds() -> None:
    by_id = {c["id"]: c for c in family_d.family_d()}
    twin = family_d.family_d_twin("D_invvol_b045_C4", 2)
    base = by_id["D_invvol_b045_C4"]
    assert twin["id"] == "D_twin2_D_invvol_b045_C4"
    assert twin["refit"] == "none" and twin["lookback_months"] is None
    assert twin["joint_shift_seed"] == 13_000_009 + 2
    for key in ("d_weights", "d_band", "model", "params", "features", "book", "family", "cell"):
        assert twin[key] == base[key]
    for bad in (-1, 3, True, 1.0):
        with pytest.raises(ValueError):
            family_d.family_d_twin("D_invvol_b0_C2", bad)  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="declared"):
        family_d.family_d_twin("A_lgbm_C2", 0)
    cfg_daily = pd.DataFrame({"drift_free": np.full(40, 0.001)})
    twin_daily = pd.DataFrame({"drift_free": np.zeros(40)})
    q = family_d.refit_question(cfg_daily, twin_daily, 4)
    assert q["seed"] == 7_300_004 and q["adopted"] is True and q["n"] == 40
    assert family_d.REFIT_SEED_BASE == 7_300_000


# ---------------------------------------------------------------------------------------------------------------------
# End to end
# ---------------------------------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def e2e(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    root = tmp_path_factory.mktemp("fd")
    # 120 days from 2023-01-01 end exactly at a month boundary: the matrix product behind apply_fit gives
    # batch-size dependent last bits for small batches, so the parity check needs whole-month folds here.
    panel = _make_fast_synthetic_panel(n_days=120, seed=10, inject_signal=True)
    ds = _create_synthetic_dataset_dir(root, panel)
    dataset_hash = json.loads((ds / "manifest.json").read_text())["datasetHash"]
    return {"root": root, "panel": panel, "ds": ds, "hash": dataset_hash}


def _d_config(cid: str, band: float, weights: str = "inv_vol") -> dict[str, Any]:
    return {
        "id": cid,
        "kind": "trial",
        "family": "D",
        "model": "ridge",
        "params": {"alpha": 1.0},
        "features": ["ret_1", "ret_4"],
        "interval": "1h",
        "h_ms": 4 * H,
        "label": "fixed",
        "side_rule": "sign",
        "threshold": 0.0,
        "size_rule": "unit",
        "lookback_months": None,
        "refit": "monthly",
        "exit": "horizon",
        "seed": 7,
        "book": "D",
        "d_weights": weights,
        "d_band": band,
        "first_refit_ms": 1680307200000,
    }


def test_run_wf_inv_vol_end_to_end(e2e: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    panel = e2e["panel"]
    fc, _ = family_c.compute_forecasts(panel, {c["id"]: c for c in family_c.family_c()}[family_d.FINALIST_ID])
    digest = family_d.canonical_digest(fc[np.isfinite(fc["f"])], "f")
    monkeypatch.setitem(family_d.PARITY_REFERENCE, e2e["hash"], digest)
    cfg = _d_config("d_e2e", 0.045)
    f = e2e["root"] / "cfg.json"
    f.write_text(json.dumps(cfg), encoding="utf-8")
    out = e2e["root"] / "out"
    receipt = cli.run_wf(f, e2e["ds"], out, commit=COMMIT, panel=panel)
    run_dir = out / "d_e2e"
    assert receipt["config"] == cfg and receipt["config_hash"] == cli.config_hash_of(cfg)
    assert receipt["d_vol"]["parity_digest"] == digest
    assert receipt["d_vol"]["parity_rows"] == int(np.isfinite(fc["f"]).sum())
    assert set(receipt["d_vol"]["missing_wf_hours_by_coin"]) == set(panel)
    dec_file = run_dir / "decisions.parquet"
    assert dec_file.is_file()
    assert receipt["decisions_sha256"] == hashlib.sha256(dec_file.read_bytes()).hexdigest()
    saved = json.loads((run_dir / "receipt.json").read_text())
    assert saved["decisions_sha256"] == receipt["decisions_sha256"] and saved["d_vol"] == receipt["d_vol"]
    dec = pd.read_parquet(dec_file)
    assert list(dec.columns) == family_d.DECISION_COLUMNS
    assert set(dec["phase"]) == {"wf", "cpcv"}
    assert dec["ranked"].any() and dec["took_prev"].any()
    assert (dec.loc[dec["phase"] == "wf", "call"].max()) < dec.loc[dec["phase"] == "cpcv", "call"].min()
    tr = pd.read_parquet(run_dir / "tranches.parquet")
    assert len(tr) > 0
    # the unchanged configurations keep their receipt keys
    plain = e2e["root"] / "plain.json"
    plain.write_text(json.dumps(_d_config("d_plain", 0.0, "rank")), encoding="utf-8")
    pr = cli.run_wf(plain, e2e["ds"], out, commit=COMMIT, panel=panel)
    assert "d_vol" not in pr and "decisions_sha256" not in pr and not (out / "d_plain" / "decisions.parquet").exists()


def test_run_wf_stops_without_a_parity_reference(e2e: dict[str, Any]) -> None:
    cfg = _d_config("d_noref", 0.0)
    f = e2e["root"] / "noref.json"
    f.write_text(json.dumps(cfg), encoding="utf-8")
    with pytest.raises(ValueError, match="no family C parity reference"):
        cli.run_wf(f, e2e["ds"], e2e["root"] / "out2", commit=COMMIT, panel=e2e["panel"])
    assert not (e2e["root"] / "out2" / "d_noref").exists()


def test_run_tripwire_checks_parity_and_runs_inv_vol(e2e: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    cfg = _d_config("d_tw", 0.0)
    f = e2e["root"] / "tw.json"
    f.write_text(json.dumps(cfg), encoding="utf-8")
    with pytest.raises(ValueError, match="no family C parity reference"):
        cli.run_tripwire(f, e2e["ds"], e2e["root"] / "tw0", commit=COMMIT, panel=e2e["panel"], shifts_days=[30])
    fc, _ = family_c.compute_forecasts(e2e["panel"], {c["id"]: c for c in family_c.family_c()}[family_d.FINALIST_ID])
    monkeypatch.setitem(family_d.PARITY_REFERENCE, e2e["hash"], family_d.canonical_digest(fc, "f"))
    res = cli.run_tripwire(f, e2e["ds"], e2e["root"] / "tw1", commit=COMMIT, panel=e2e["panel"], shifts_days=[30])
    assert res["n"] == 1 and (e2e["root"] / "tw1" / "d_tw" / "tripwire.json").is_file()
    assert not (e2e["root"] / "tw1" / "d_tw" / "decisions.parquet").exists()


def test_dev_end_is_the_finalist_partition_end() -> None:
    by_id = {c["id"]: c for c in family_c.family_c()}
    assert by_id[family_d.FINALIST_ID]["partition_end_ms"] == DEV_END
