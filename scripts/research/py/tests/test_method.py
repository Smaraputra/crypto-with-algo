"""Tests for r4.method pinning the Round 4 method lock text v3 and constants."""

from __future__ import annotations

from datetime import UTC, datetime

from r4 import method


def test_constants_exact_values() -> None:
    """Every constant equals the exact value listed in the method brief."""
    assert method.DEV_START == 1640995200000
    assert method.DEV_END == 1782864000000
    assert method.TIER_B_START == 1672531200000
    assert method.WF_FIRST_REFIT == 1672531200000
    assert method.WF_FIRST_REFIT_TIER_B == 1704067200000
    assert method.H_START == 1577836800000
    assert method.H_END == 1640995200000

    assert method.UNIVERSE == (
        "BTCUSDT",
        "ETHUSDT",
        "BNBUSDT",
        "SOLUSDT",
        "XRPUSDT",
        "ADAUSDT",
        "DOGEUSDT",
        "AVAXUSDT",
        "DOTUSDT",
        "LINKUSDT",
    )

    assert method.H_EARLY_COINS == (
        "BTCUSDT",
        "ETHUSDT",
        "XRPUSDT",
        "LINKUSDT",
        "ADAUSDT",
        "BNBUSDT",
    )

    assert method.DECISION_INTERVALS_MS == {"1h": 3600000, "4h": 14400000}
    assert method.ENTRY_DELAY_MS == 600000
    assert method.HORIZONS_MS == {
        "1h": (14400000, 28800000),
        "4h": (14400000, 28800000, 86400000),
    }

    assert method.CPCV_GROUPS == 6
    assert method.CPCV_TEST_GROUPS == 2
    assert method.CPCV_EMBARGO_MS == 2592000000
    assert method.CPCV_LONG_LOOKBACK_FEATURES == (
        "trend_1d",
        "atr14_1d",
        "dist_pdh",
        "dist_pdl",
        "dist_poc",
        "trend_4h",
        "funding_z30d",
    )
    assert method.FINALIST_DESCRIPTIVE_CPCV_EMBARGO_MS == 17280000000

    assert method.WF_LOOKBACK_ARMS_MONTHS == (12, 24, None)
    assert method.WF_LOOKBACK_ARMS_MONTHS_TIER_B == (12, None)

    assert method.TRIPLE_BARRIER_K == 1.0
    assert method.SIGMA_TRAILING_MS == 86400000

    assert method.BUDGET == {
        "A": 48,
        "B": 24,
        "D": 12,
        "E": 24,
        "retests": 12,
    }
    assert method.BUDGET_FORECAST_C == 12
    assert method.DSR_TRIALS_MIN == 120
    assert method.PROGRAM_TRIALS_BEFORE == 2204
    assert method.MAX_FINALISTS == 3
    assert method.MAX_FORECAST_FINALISTS == 1
    assert method.MAX_H_READ_IDS == 4

    assert method.BAR == {
        "cpcv_paths_positive_min": 4,
        "pbo_max": 0.25,
        "cscv_groups": 16,
        "dsr_min": 0.95,
        "random_entry_draws": 1000,
        "random_entry_shift_min_days": 7,
        "random_entry_p_max": 0.05,
        "spa_reps": 1000,
        "spa_mean_block_days": 10,
        "spa_p_max": 0.05,
        "label_shift_min_days": 30,
        "label_shift_perms": 100,
        "symbols_positive_min": 7,
        "stress_fee_mult": 1.5,
        "stress_slippage_mult": 2.0,
    }

    assert method.BAR_FORECAST == {
        "dm_p_max": 0.05,
        "coverage_levels": (0.80, 0.95),
        "coverage_tolerance": 0.02,
        "symbols_min": 8,
        "ewma_halflife_windows": 7,
    }

    assert method.STAY_OUT == {
        "vol_percentile": 0.90,
        "vol_percentile_lookback_days": 90,
        "range_cost_multiple": 3.0,
        "range_share_min": 0.60,
    }
    assert method.STAY_OUT_BLOCK_DAYS == 10

    assert method.CONTROLS == {
        "positive_detection_power_min": 0.80,
        "noise_configs": 40,
        "noise_pass_max": 5,
    }
    assert method.NOISE_SHIFT_REJECT_MAX == 6

    assert method.REFIT == {
        "rule": "paired_block_bootstrap_90ci_entirely_above_zero",
        "mean_block_days": 10,
        "reps": 1000,
    }

    assert method.TIER_B_STAMP_MS == 300000

    assert method.H_RULES == {
        "min_trades_per_coin": 30,
        "listing_burn_in_days": 60,
        "coin_share_min": 0.6,
        "power_min": 0.5,
    }
    assert method.H_NULL_P_MAX == 0.05 / 3

    assert method.JOINT_SHIFT_GRID_MS == 86400000
    assert method.HOLDOUT_LEDGER_PATH == "~/round4-out/holdout-reads.jsonl"
    assert method.LABEL_SHIFT_TRIPWIRE == 60

    assert method.LAB_V5 == {
        "alpha": 0.005,
        "max_slots": 3,
        "threshold": 600,
        "warmup_bets": 30,
        "scale_sd_multiple": 4.0,
        "loss_floor_x": -2.0,
        "statistic": "daily_beta_hedged_book_return",
        "horizon_months": 24,
    }


def test_epoch_constants_match_datetime_utc() -> None:
    """The epoch constants equal datetime(YYYY, M, D, tzinfo=timezone.utc) timestamps * 1000."""
    expected_epochs = {
        "DEV_START": (datetime(2022, 1, 1, tzinfo=UTC), method.DEV_START),
        "DEV_END": (datetime(2026, 7, 1, tzinfo=UTC), method.DEV_END),
        "TIER_B_START": (datetime(2023, 1, 1, tzinfo=UTC), method.TIER_B_START),
        "WF_FIRST_REFIT": (datetime(2023, 1, 1, tzinfo=UTC), method.WF_FIRST_REFIT),
        "WF_FIRST_REFIT_TIER_B": (datetime(2024, 1, 1, tzinfo=UTC), method.WF_FIRST_REFIT_TIER_B),
        "H_START": (datetime(2020, 1, 1, tzinfo=UTC), method.H_START),
        "H_END": (datetime(2022, 1, 1, tzinfo=UTC), method.H_END),
    }

    for name, (dt, actual_ms) in expected_epochs.items():
        expected_ms = int(dt.timestamp() * 1000)
        assert actual_ms == expected_ms, f"{name} expected {expected_ms} but got {actual_ms}"


def test_budget_and_dsr_trials_min() -> None:
    """Requirement 3: sum(BUDGET.values()) == DSR_TRIALS_MIN == 120."""
    assert sum(method.BUDGET.values()) == method.DSR_TRIALS_MIN == 120


def test_h_null_p_max() -> None:
    """Requirement 4: H_NULL_P_MAX == 0.05 / 3."""
    assert method.H_NULL_P_MAX == 0.05 / 3


def test_lab_v5_threshold_relation() -> None:
    """Requirement 5: LAB_V5['threshold'] == LAB_V5['max_slots'] / LAB_V5['alpha']."""
    assert method.LAB_V5["threshold"] == method.LAB_V5["max_slots"] / method.LAB_V5["alpha"]


def test_docstring_required_substrings() -> None:
    """Requirement 6: The module docstring contains every required lock text substring."""
    doc = method.__doc__
    assert doc is not None

    required_substrings = (
        "LOCK TEXT V3",
        "DRIFT-FREE DAILY SERIES",
        "beta-hedged",
        "N = max(120",
        "no-bet day",
        "whole days",
        "inconclusive",
        "Hansen's consistent p-value (SPA_c)",
        "DEV_START 2022-01-01",
        "H 2020-01-01 to 2022-01-01",
        "threshold 600",
        "BOOK RULE",
        "PREDICTIONS",
        "STOP RULE",
    )

    doc_normalized = " ".join(doc.split())
    for substring in required_substrings:
        assert (
            substring in doc or substring in doc_normalized or substring.capitalize() in doc or substring.lower() in doc
        ), f"Expected substring not found in docstring: {substring!r}"


def test_signed_text_unchanged_and_amendments_appended_only() -> None:
    """The text the owner signed (commit bbc4330b) is byte-identical at the head of the docstring.

    Anything after it is an appended AMENDMENT, never an edit (lock M: "Changes after the first development read are
    AMENDMENTS appended below, never edits").
    """
    from pathlib import Path

    signed = (Path(__file__).parent / "fixtures" / "method_doc_signed_bbc4330b.txt").read_text(encoding="utf-8")
    doc = method.__doc__
    assert doc is not None
    assert doc.startswith(signed)
    tail = doc[len(signed) :]
    assert tail == "" or tail.lstrip("\n").startswith("AMENDMENT ")


def test_signed_amendments_unchanged_and_later_ones_appended_only() -> None:
    """Amendment 1 (signed for the text at 3c68c376, record 2f4b26f1) and Amendment 2 (signed at 245c4522) follow M
    byte for byte. Anything after them is a later appended AMENDMENT, never an edit (Gate P pre-run review 3, F10).
    """
    from pathlib import Path

    fixtures = Path(__file__).parent / "fixtures"
    signed = (fixtures / "method_doc_signed_bbc4330b.txt").read_text(encoding="utf-8")
    a1 = (fixtures / "method_doc_amendment1_signed_3c68c376.txt").read_text(encoding="utf-8")
    a2 = (fixtures / "method_doc_amendment2_signed_245c4522.txt").read_text(encoding="utf-8")
    doc = method.__doc__
    assert doc is not None
    tail = doc[len(signed) :]
    start = tail.index("AMENDMENT 1 (")
    assert tail[:start].strip() == ""
    assert tail[start:].startswith(a1 + a2)
    rest = tail[start + len(a1) + len(a2) :]
    assert rest == "" or rest.lstrip("\n").startswith("AMENDMENT 3 ")
