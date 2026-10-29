"""Brief 28e: the spec's planted reversal control, optional stopping on firing models, dossier checks (synthetic)."""

from __future__ import annotations

import copy
import inspect
import json
from typing import Any

import numpy as np
import pandas as pd
import pytest

from r4 import bar
from r4 import calibration as cal
from r4.bar import JointShiftStats
from r4.method import ENTRY_DELAY_MS, UNIVERSE
from r4.synth import synth_panel
from tests.test_calibration_power import _exit_block, _inputs

B0 = 1_672_531_200_000
DAY = 86_400_000
HOUR = 3_600_000


# ---------------------------------------------------------------------------
# Change 1: one planted-reversal implementation, in r4.plant
# ---------------------------------------------------------------------------


def _small_panel(seed: int = 3, days: int = 20):
    syms = list(UNIVERSE[:3])
    cov = (0.015**2) * (0.3 * np.ones((3, 3)) + 0.7 * np.eye(3))
    return synth_panel(cov, syms, B0, B0 + days * DAY, seed)


def test_plant_events_is_public_and_follows_the_spec_plant():
    from r4.plant import EVENT_AMP, plant_events

    assert EVENT_AMP == 0.02
    base = _small_panel()
    panel, events = plant_events(base, seed=5)
    again_panel, again_events = plant_events(base, seed=5)
    assert set(events) == set(base)
    for sym, (e, sign) in events.items():
        assert np.array_equal(e, again_events[sym][0]) and np.array_equal(sign, again_events[sym][1])
        gaps = np.diff(e) // HOUR
        assert len(e) > 5 and gaps.min() >= 6 and gaps.max() <= 15
        assert set(np.unique(sign)) <= {-1, 1}
        five = panel[sym]["5m"]
        t = five["t"].to_numpy()
        v, tbv = five["v"].to_numpy(), five["tbv"].to_numpy()
        for ee, sg in zip(e[:5], sign[:5], strict=True):
            i = int(np.searchsorted(t, ee - 15 * 60_000))
            share = tbv[i : i + 3] / v[i : i + 3]
            assert np.allclose(share, 0.95 if sg > 0 else 0.05)
        # the price ramp over [e + 30m, e + 90m) is +-2% in total
        i0 = int(np.searchsorted(t, e[0] + 30 * 60_000))
        ratio = five["o"].to_numpy()[i0 + 12] / base[sym]["5m"]["o"].to_numpy()[i0 + 12]
        before = five["o"].to_numpy()[i0] / base[sym]["5m"]["o"].to_numpy()[i0]
        assert abs(np.log(ratio / before) - sign[0] * 0.02) < 1e-9
        assert (again_panel[sym]["5m"]["c"].to_numpy() == five["c"].to_numpy()).all()


def test_classify_events_hand_case():
    from r4.plant import classify_events

    e = np.array([B0 + 10 * HOUR], dtype=np.int64)
    events = {"BTCUSDT": (e, np.array([1]))}  # a rise at hour 10
    rows = []
    for sym, side, entry_h in (
        ("BTCUSDT", -1, 9),  # short into a rise at hour 10: adverse, planted
        ("BTCUSDT", 1, 9),  # long into a rise: favourable, neither
        ("BTCUSDT", -1, 40),  # far from any event: unplanted
        ("BTCUSDT", -1, 7),  # event too close to the end of the hold (needs e <= exit - 2h): neither
    ):
        entry = B0 + entry_h * HOUR + ENTRY_DELAY_MS
        rows.append({"symbol": sym, "side": side, "entry_ms": entry, "exit_ms": entry + 4 * HOUR})
    ent = pd.DataFrame(rows)
    planted, unplanted, drop = classify_events(ent, events)
    assert planted.tolist() == [True, False, False, False]
    assert unplanted.tolist() == [False, False, True, False]
    assert int(drop[0]) == int(e[0]) + 30 * 60_000
    assert drop[1] == np.iinfo(np.int64).max


def test_test_module_imports_the_public_functions():
    import tests.test_exit_models as tem
    from r4 import plant

    assert tem.plant_events is plant.plant_events and tem.classify_events is plant.classify_events
    assert not hasattr(tem, "_plant_events") and not hasattr(tem, "_classify")


# ---------------------------------------------------------------------------
# Change 6: one p-value rule
# ---------------------------------------------------------------------------


def test_joint_shift_p_edge_cases():
    null = np.array([0.1, 0.2, 0.3, 0.4])
    assert bar.joint_shift_p(JointShiftStats(0.25, null, [7, 8, 9, 10], 2, 5), 4) == (
        pytest.approx((1 + 2) / 5),
        pytest.approx(2 / (4 * 5)),
    )
    # no tranches: p 1, nothing dropped
    assert bar.joint_shift_p(JointShiftStats(float("nan"), np.array([]), [], 0, 0), 4) == (1.0, 0.0)
    # no shift fits: p 1, everything dropped (the drop share is 1, not 0)
    assert bar.joint_shift_p(JointShiftStats(0.2, np.array([]), [], 0, 5), 4) == (1.0, 1.0)


def test_joint_shift_null_and_the_exit_block_share_the_rule(monkeypatch):
    fake = JointShiftStats(0.25, np.array([0.1, 0.2, 0.3, 0.4]), [7, 8, 9, 10], 2, 5)
    monkeypatch.setattr(bar, "joint_shift_stats", lambda *a, **k: fake)
    calls: list[Any] = []
    real = bar.joint_shift_p

    def spy(stats, n_draws):
        calls.append((stats, n_draws))
        return real(stats, n_draws)

    monkeypatch.setattr(bar, "joint_shift_p", spy)
    p, drop, obs, shifts = bar.joint_shift_null([], {}, [], 0, 1, n_draws=4)
    assert calls == [(fake, 4)] and (p, drop, obs, shifts) == (
        pytest.approx(0.6),
        pytest.approx(0.1),
        0.25,
        [7, 8, 9, 10],
    )
    assert "joint_shift_p(" in inspect.getsource(cal.evaluate_exit_block)
    assert "np.sum(stats.null_stats" not in inspect.getsource(cal.evaluate_exit_block)


# ---------------------------------------------------------------------------
# Change 2: the registered planted intrabar control
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def planted_control() -> dict[str, Any]:
    return cal.planted_intrabar_control()


def test_planted_control_registration(planted_control):
    out = planted_control
    assert out["panel_seeds"] == [7000, 7002, 7004, 7006]
    assert out["event_seeds"] == [7001, 7003, 7005, 7007]
    assert out["n_panels"] == 4 and out["n_days"] == 100 and out["n_coins"] == 4
    assert out["vol"] == 0.015 and out["interval"] == "1h" and out["h_ms"] == 4 * HOUR
    assert out["fit_days"] == 70 and out["model_seed"] == 7
    assert out["features"] == ["taker_imb_last15", "ret_15m_last"]
    assert out["min_close_ahead_rate"] == 0.8 and out["max_false_close_rate"] == 0.2
    assert set(out["rules"]) == {"E4", "E5", "E6"}
    assert "per_seed" in out["rules"]["E4"] and len(out["rules"]["E4"]["per_seed"]) == 4
    for rule, r in out["rules"].items():
        assert r["n_planted"] >= 100 and r["n_unplanted"] >= 100, rule
        assert 0.0 <= r["close_ahead_rate"] <= 1.0 and 0.0 <= r["false_close_rate"] <= 1.0
        assert r["met"] is bool(r["increment"] > 0.0 and r["close_ahead_rate"] >= 0.8 and r["false_close_rate"] <= 0.2)
        assert r["n_planted"] == sum(s["n_planted"] for s in r["per_seed"])
        assert r["spec"] == next(s for s in cal.EXIT_BLOCK_SPECS if s["rule"] == rule)
    assert out["met"] is all(r["met"] for r in out["rules"].values())
    json.dumps(out)


def test_planted_control_counts_match_the_25e_classification(planted_control):
    """The pooled counts are the classify_events counts of the four registered planted panels (same entries)."""
    from r4.plant import classify_events, plant_events

    n_pl = n_un = 0
    for k in range(4):
        cov = (0.015**2) * (0.3 * np.ones((4, 4)) + 0.7 * np.eye(4))
        base = synth_panel(cov, list(UNIVERSE[:4]), B0, B0 + 100 * DAY, 7000 + 2 * k)
        _, events = plant_events(base, seed=7001 + 2 * k)
        cut = B0 + 70 * DAY
        top = np.arange(cut, B0 + 100 * DAY - 6 * HOUR, HOUR, dtype=np.int64)
        parts = []
        for sym in base:
            for side in (1, -1):
                parts.append(
                    pd.DataFrame(
                        {
                            "symbol": sym,
                            "side": side,
                            "entry_ms": top + ENTRY_DELAY_MS,
                            "exit_ms": top + ENTRY_DELAY_MS + 4 * HOUR,
                        }
                    )
                )
        pl, un, _ = classify_events(pd.concat(parts, ignore_index=True), events)
        n_pl += int(pl.sum())
        n_un += int(un.sum())
    for r in planted_control["rules"].values():
        assert (r["n_planted"], r["n_unplanted"]) == (n_pl, n_un)


def test_old_planted_design_is_gone():
    assert not hasattr(cal, "_plant_intrabar")
    doc = cal.planted_intrabar_control.__doc__ or ""
    assert "22 to 29%" in doc and "7000 to 7003" in doc


# ---------------------------------------------------------------------------
# Change 3: optional stopping on E4 and E5 models that fire
# ---------------------------------------------------------------------------


ROWS8 = {"E2", "E3", "E4", "E5", "E6", "X1", "E4_loose", "E5_loose"}


def test_optional_stopping_fits_on_each_panels_own_features(monkeypatch):
    from r4.exit_models import ExitModelFactory

    fits: list[tuple[Any, ...]] = []
    real_fit = ExitModelFactory.fit
    real_init = ExitModelFactory.__init__
    made: list[tuple[Any, ...]] = []

    def init(self, panel, interval, h_ms, features, seed, *a, **k):
        made.append((interval, h_ms, tuple(features), seed))
        return real_init(self, panel, interval, h_ms, features, seed, *a, **k)

    def counting_fit(self, *a, **k):
        fits.append(a)
        return real_fit(self, *a, **k)

    monkeypatch.setattr(ExitModelFactory, "__init__", init)
    monkeypatch.setattr(ExitModelFactory, "fit", counting_fit)
    out = cal.optional_stopping_check(n_panels=3, n_days=60, rules=("E4", "E5", "E4_loose", "E5_loose"), seed_base=900)
    assert len(fits) == 3, "one fit per panel, shared by the registered and the loosened rows"
    assert set(made) == {("4h", int(cal._exit_base_config()["h_ms"]), ("taker_imb_last15", "ret_15m_last"), 7)}
    assert set(out["rules"]) == {"E4", "E5", "E4_loose", "E5_loose"}
    assert not hasattr(cal, "optional_stopping_models")
    assert not hasattr(cal, "OPT_STOP_MODEL_PANEL_SEED")


@pytest.fixture(scope="module")
def registered_optional_stopping() -> dict[str, Any]:
    return cal.optional_stopping_check()


def _print_table(title: str, out: dict[str, Any]) -> None:
    print(f"\n{title}")
    for rule, r in out["rules"].items():
        print(
            f"{rule:9s} mean {r['mean']:+.3e} t {r['t']:+.3f} p {r['p_two_sided']:.4f} early {r['early_share']:.4f} "
            f"medhold {r['median_hold_share']:.3f} ok {r['ok']}"
        )


def test_optional_stopping_without_a_leak_passes_and_loose_rows_fire(registered_optional_stopping):
    out = registered_optional_stopping
    assert out["n_panels"] == 20 and out["n_days"] == 75 and out["seed_base"] == 6000
    assert set(out["rules"]) == ROWS8
    _print_table("no leak", out)
    for rule in ("E4_loose", "E5_loose"):
        assert out["rules"][rule]["early_share"] >= 0.10, (rule, out["rules"][rule]["early_share"])
    assert out["met"] is True, {k: v["ok"] for k, v in out["rules"].items()}


def test_optional_stopping_sees_a_feature_path_leak(monkeypatch):
    """Features at tau_f read at tau_f + 30 minutes, in training and serving alike (both go through TauFrame.market)."""
    from r4.exit_models import TauFrame

    real = TauFrame.market

    def leaking(self, tau_f, dtype=np.float64):
        return real(self, np.asarray(tau_f, dtype=np.int64) + 1_800_000, dtype)

    monkeypatch.setattr(TauFrame, "market", leaking)
    out = cal.optional_stopping_check()
    _print_table("leak: features read 30 minutes ahead", out)
    assert out["met"] is False
    positive = [
        r
        for r in ("E4", "E5", "E4_loose", "E5_loose")
        if out["rules"][r]["significant"] and out["rules"][r]["mean"] > 0
    ]
    assert positive, "at least one model row must be significantly positive"


def test_optional_stopping_sees_a_fifteen_minute_feature_path_leak(monkeypatch):
    """Brief 28g, power record: a 15-minute look-ahead in the shared TauFrame.market lookup, registered sizes.

    The fill is 10 minutes after tau, so a 15-minute read reaches 5 minutes past the fill. The review measured
    t 3.7 (E4_loose) and 9.6 (E5_loose). The numbers are printed, nothing here is tuned.
    """
    from r4.exit_models import TauFrame

    real = TauFrame.market

    def leaking(self, tau_f, dtype=np.float64):
        return real(self, np.asarray(tau_f, dtype=np.int64) + 900_000, dtype)

    monkeypatch.setattr(TauFrame, "market", leaking)
    out = cal.optional_stopping_check()
    _print_table("leak: features read 15 minutes ahead", out)
    for rule in ("E4", "E5", "E4_loose", "E5_loose"):
        r = out["rules"][rule]
        print(f"LEAK15 {rule:9s} t {r['t']:+.3f} p {r['p_two_sided']:.5f} early {r['early_share']:.4f} ok {r['ok']}")
    assert out["met"] is False
    assert any(out["rules"][r]["significant"] and out["rules"][r]["mean"] > 0 for r in ("E4_loose", "E5_loose"))


def _peeking_replay(rule: str):
    from r4.exits import STEP_MS, ExitContext

    original = ExitContext.replay

    def peeking(self, entries, spec):
        out = original(self, entries, spec).copy()
        if getattr(spec, "rule", None) != rule:
            return out
        for i, row in enumerate(entries.itertuples(index=False)):
            b = self.bars[row.symbol]
            j = int(np.searchsorted(b.t, row.exit_ms))
            if row.side * (b.o[j] - row.entry_price) < 0:
                out.loc[i, ["exit_ms", "exit_price", "exit_fill", "exit_reason"]] = [
                    row.entry_ms + STEP_MS,
                    row.entry_price,
                    "taker",
                    "model_exit",
                ]
        return out

    return peeking


@pytest.mark.parametrize("rule", ["E4", "E5"])
def test_optional_stopping_catches_a_look_ahead_model_exit(monkeypatch, rule):
    from r4.exits import ExitContext

    honest = cal.optional_stopping_check(n_panels=8, n_days=22, rules=(rule,), seed_base=777)
    assert honest["rules"][rule]["significant"] is False
    monkeypatch.setattr(ExitContext, "replay", _peeking_replay(rule))
    cheat = cal.optional_stopping_check(n_panels=8, n_days=22, rules=(rule,), seed_base=777)
    assert cheat["rules"][rule]["significant"] is True and cheat["rules"][rule]["mean"] > 0.0
    assert cheat["rules"][rule]["p_two_sided"] < 0.01 and cheat["rules"][rule]["ok"] is False


# ---------------------------------------------------------------------------
# Change 4 and 5: the new prediction and the dossier checks
# ---------------------------------------------------------------------------


def test_new_prediction_is_registered_and_evaluated(tmp_path):
    assert cal.PREDICTIONS["exit_optional_stopping_zero_mean"]["status"] == "gated"
    assert cal.PREDICTIONS["exit_optional_stopping_zero_mean"]["text"] == (
        "On 20 zero-drift synthetic panels of 75 days no exit's cost-free mean per tranche differs from zero "
        "(two-sided 0.01), and X1's is not positive. E4 and E5 fit on each panel's own real features, at the "
        "registered and loosened thresholds."
    )
    sub = tmp_path / "ok"
    sub.mkdir()
    doc = cal.write_dossier(sub / "d.json", **_inputs(sub))
    p = doc["predictions"]["exit_optional_stopping_zero_mean"]
    assert p["as_predicted"] is True and p["evidence"] == "exit_block"
    assert set(p["observed"]) == ROWS8
    bad = _exit_block(opt_miss=("E4",))
    sub = tmp_path / "miss"
    sub.mkdir()
    doc = cal.write_dossier(sub / "d.json", **_inputs(sub, exit_block=bad))
    assert doc["predictions"]["exit_optional_stopping_zero_mean"]["as_predicted"] is False
    assert doc["gate_p_ready"] is False  # gated since brief 28f


def _mut(fn):
    def apply(b):
        b = copy.deepcopy(b)
        fn(b)
        return b

    return apply


_REFUSALS: dict[str, Any] = {
    "config id changed": _mut(lambda b: b["configs"][0].__setitem__("id", "other")),
    "config order swapped": _mut(lambda b: b["configs"].reverse()),
    "config hash changed": _mut(lambda b: b["configs"][2].__setitem__("config_hash", "0" * 64)),
    "config hash missing": _mut(lambda b: b["configs"][2].pop("config_hash")),
    "draws fewer": _mut(lambda b: b["configs"][1].__setitem__("draws", 10)),
    "joint seed wrong": _mut(lambda b: b["configs"][3].__setitem__("seed", 1)),
    "replay mismatches": _mut(lambda b: b["configs"][4].__setitem__("replay_reproduction", {"n": 5, "mismatches": 1})),
    "shift zero not ok": _mut(lambda b: b["configs"][0].__setitem__("shift_zero", {"ok": False})),
    "entries not matching base": _mut(lambda b: b["configs"][5].__setitem__("entries_match_base", False)),
    "determinism not identical": _mut(lambda b: b["determinism"].__setitem__("identical", False)),
    "determinism skipped": _mut(lambda b: b["determinism"].__setitem__("skipped", True)),
    "determinism missing": _mut(lambda b: b.pop("determinism")),
    "optional stopping missing": _mut(lambda b: b.pop("optional_stopping")),
    "optional stopping panels": _mut(lambda b: b["optional_stopping"].__setitem__("n_panels", 3)),
    "optional stopping days": _mut(lambda b: b["optional_stopping"].__setitem__("n_days", 60)),
    "optional stopping seed base": _mut(lambda b: b["optional_stopping"].__setitem__("seed_base", 1)),
    "optional stopping rule missing": _mut(lambda b: b["optional_stopping"]["rules"].pop("E5")),
    "optional stopping loose row missing": _mut(lambda b: b["optional_stopping"]["rules"].pop("E4_loose")),
    "diagnostics missing": _mut(lambda b: b.pop("diagnostics")),
    "median hold missing": _mut(lambda b: b["diagnostics"].pop("median_hold")),
    "planted missing": _mut(lambda b: b["diagnostics"].pop("planted_intrabar")),
    "planted panel seeds": _mut(
        lambda b: b["diagnostics"]["planted_intrabar"].__setitem__("panel_seeds", [1, 2, 3, 4])
    ),
    "planted event seeds": _mut(
        lambda b: b["diagnostics"]["planted_intrabar"].__setitem__("event_seeds", [1, 2, 3, 4])
    ),
    "planted days": _mut(lambda b: b["diagnostics"]["planted_intrabar"].__setitem__("n_days", 60)),
    "planted panels": _mut(lambda b: b["diagnostics"]["planted_intrabar"].__setitem__("n_panels", 2)),
    "planted coins": _mut(lambda b: b["diagnostics"]["planted_intrabar"].__setitem__("n_coins", 6)),
    "dataset hash differs": _mut(lambda b: b.__setitem__("dataset_hash", "f" * 64)),
    "dataset hash missing": _mut(lambda b: b.pop("dataset_hash")),
    "provenance differs": _mut(lambda b: b["provenance"].__setitem__("commits", ["d" * 40])),
}


@pytest.mark.parametrize("label", sorted(_REFUSALS))
def test_dossier_refuses_an_unregistered_exit_block(tmp_path, label):
    sub = tmp_path / "case"
    sub.mkdir()
    block = _REFUSALS[label](_exit_block())
    with pytest.raises(ValueError):
        cal.write_dossier(sub / "x.json", **_inputs(sub, exit_block=block))
    assert not (sub / "x.json").exists()


def test_dossier_requires_the_exit_block(tmp_path):
    sub = tmp_path / "none"
    sub.mkdir()
    with pytest.raises(ValueError, match="exit_block"):
        cal.write_dossier(sub / "x.json", **_inputs(sub, exit_block=None))
    assert not (sub / "x.json").exists()


def test_registered_block_passes_the_validator():
    assert cal._validate_exit_block(_exit_block()) == 0
