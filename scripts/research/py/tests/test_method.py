"""Tests for r4.method pinning the Round 4 method lock text v2 and constants."""

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
    assert method.DSR_TRIALS == 120
    assert method.PROGRAM_TRIALS_BEFORE == 2204
    assert method.MAX_FINALISTS == 3

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

    assert method.CONTROLS == {
        "positive_detection_power_min": 0.80,
        "noise_configs": 40,
        "noise_pass_max": 5,
    }

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
        "null_p_max": 0.0167,
        "power_min": 0.5,
    }

    assert method.LAB_V5 == {
        "alpha": 0.005,
        "max_slots": 3,
        "threshold": 600,
        "warmup_bets": 30,
        "scale_sd_multiple": 4.0,
        "loss_unbounded": True,
        "statistic": "daily_mtm_drift_hedged_book_return",
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


def test_budget_and_dsr_trials() -> None:
    """Requirement 3: sum(BUDGET.values()) == DSR_TRIALS == 120."""
    assert sum(method.BUDGET.values()) == method.DSR_TRIALS == 120


def test_h_rules_null_p_max() -> None:
    """Requirement 4: H_RULES['null_p_max'] equals round(0.05 / MAX_FINALISTS, 4)."""
    assert method.H_RULES["null_p_max"] == round(0.05 / method.MAX_FINALISTS, 4)


def test_lab_v5_threshold_relation() -> None:
    """Requirement 5: LAB_V5['threshold'] == LAB_V5['max_slots'] / LAB_V5['alpha']."""
    assert method.LAB_V5["threshold"] == method.LAB_V5["max_slots"] / method.LAB_V5["alpha"]


def test_docstring_required_substrings() -> None:
    """Requirement 6: The module docstring contains every required lock text substring."""
    doc = method.__doc__
    assert doc is not None

    required_substrings = (
        "LOCK TEXT V2",
        "DEV_START 2022-01-01",
        "DEV_END 2026-07-01",
        "H 2020-01-01 to 2022-01-01",
        "A 48, B 24, D 12, E 24, re-tests 12",
        "threshold 600",
        "alpha 0.005",
        "PBO at most 0.25",
        "N = 120",
        "Hansen SPA",
        "embargo 30 days",
        "drift-free",
        "BOOK RULE",
        "PREDICTIONS",
        "STOP RULE",
    )

    for substring in required_substrings:
        assert substring in doc or substring.capitalize() in doc, (
            f"Expected substring not found in docstring: {substring!r}"
        )

    assert "Threshold 600" in doc
