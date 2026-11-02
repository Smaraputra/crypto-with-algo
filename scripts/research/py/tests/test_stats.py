"""Tests for r4.stats module."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest

from r4.stats import (
    bootstrap_ci,
    circular_block_shuffle,
    cscv_pbo,
    deflated_sharpe,
    expected_max_sharpe,
    normal_cdf,
    normal_quantile,
    p_value,
    per_period_sharpe,
    probabilistic_sharpe,
    psr_radicand,
    random_entry_null,
    sample_kurtosis,
    sample_skewness,
    shuffled_label_null,
    stationary_bootstrap_indices,
    wilson,
)

FIXTURES_FILE = Path(__file__).parent / "fixtures" / "stats.json"


@pytest.fixture(scope="module")
def stats_fixture() -> dict:
    with open(FIXTURES_FILE, encoding="utf-8") as f:
        return json.load(f)


def test_fixture_expected_max_sharpe(stats_fixture: dict):
    for item in stats_fixture["emax"]:
        nt = item["numTrials"]
        var = item["varianceOfTrialSharpes"]
        expected = item["expectedMaxSharpe"]
        actual = expected_max_sharpe(nt, var)
        if expected == 0.0:
            assert actual == 0.0
        else:
            rel_err = abs(actual - expected) / abs(expected)
            assert rel_err <= 1e-9


def test_fixture_psr_radicand(stats_fixture: dict):
    for item in stats_fixture["psr"]:
        actual = psr_radicand(item["observedSharpe"], item["skewness"], item["kurtosis"])
        assert abs(actual - item["radicand"]) <= 1e-12


def test_fixture_probabilistic_sharpe(stats_fixture: dict):
    for item in stats_fixture["psr"]:
        actual = probabilistic_sharpe(
            item["observedSharpe"],
            item["benchmarkSharpe"],
            item["nObservations"],
            item["skewness"],
            item["kurtosis"],
        )
        if item["probability"] is None:
            assert math.isnan(actual)
        else:
            assert abs(actual - item["probability"]) <= 1e-7


def test_fixture_deflated_sharpe(stats_fixture: dict):
    for item in stats_fixture["dsr"]:
        bench, prob = deflated_sharpe(
            item["observedSharpe"],
            item["numTrials"],
            item["varianceOfTrialSharpes"],
            item["n"],
            item["skewness"],
            item["kurtosis"],
        )
        assert abs(bench - item["benchmarkSharpe"]) <= 1e-7
        assert abs(prob - item["probability"]) <= 1e-7


def test_fixture_normal_and_quant(stats_fixture: dict):
    for item in stats_fixture["normal"]:
        assert abs(normal_cdf(item["x"]) - item["cdf"]) <= 1e-7

    for item in stats_fixture["quant"]:
        assert abs(normal_quantile(item["p"]) - item["q"]) <= 1e-7


def test_fixture_moments(stats_fixture: dict):
    for sample, expected in zip(stats_fixture["samples"], stats_fixture["moments"], strict=True):
        sr = per_period_sharpe(sample)
        skew = sample_skewness(sample)
        kurt = sample_kurtosis(sample)

        sr_exp = expected["perPeriodSharpe"]
        assert abs(sr - sr_exp) / abs(sr_exp) <= 1e-9

        skew_exp = expected["skewness"]
        if abs(skew_exp) < 1e-12:
            assert abs(skew - skew_exp) <= 1e-12
        else:
            assert abs(skew - skew_exp) / abs(skew_exp) <= 1e-9

        kurt_exp = expected["kurtosis"]
        assert abs(kurt - kurt_exp) / abs(kurt_exp) <= 1e-9


def test_expected_max_sharpe_edges():
    with pytest.raises(ValueError):
        expected_max_sharpe(10, -0.01)
    assert expected_max_sharpe(1, 0.05) == 0.0
    assert expected_max_sharpe(0, 0.05) == 0.0


def test_bootstrap():
    n = 100
    indices = stationary_bootstrap_indices(n, mean_block_len=10.0, rng=42)
    assert len(indices) == n
    assert np.all(indices >= 0)
    assert np.all(indices < n)

    run_indices = stationary_bootstrap_indices(n, mean_block_len=1e9, rng=42)
    assert len(run_indices) == n
    assert np.all(run_indices[1:] == (run_indices[:-1] + 1) % n)

    series = np.array([1.2, 2.5, -0.5, 3.1, 0.8, -1.1, 4.0, 2.2])
    ci1 = bootstrap_ci(series, np.mean, iterations=300, mean_block_len=4.0, seed=123)
    ci2 = bootstrap_ci(series, np.mean, iterations=300, mean_block_len=4.0, seed=123)
    assert ci1 == ci2
    point, low, high = ci1
    assert low <= point <= high


def test_wilson():
    low, high = wilson(5, 10)
    assert abs(low - 0.2366) < 1e-4
    assert abs(high - 0.7634) < 1e-4

    assert wilson(0, 0) == (0.0, 1.0)
    low0, high0 = wilson(0, 10)
    assert low0 == 0.0
    assert 0.0 < high0 < 1.0


def test_cscv():
    t_periods = 160
    n_configs = 10
    dominating_perf = np.zeros((t_periods, n_configs))
    dominating_perf[:, 0] = [1.0 if t % 2 == 0 else 2.0 for t in range(t_periods)]
    col_other = np.array([-1.0 if t % 2 == 0 else -0.5 for t in range(t_periods)])
    dominating_perf[:, 1:] = col_other[:, None]
    pbo_dom, logits_dom = cscv_pbo(dominating_perf, n_groups=16)
    assert pbo_dom == 0.0

    # 2. Pure-noise configurations (T = 1600, N = 20, seed 1), PBO in [0.3, 0.7]
    rng = np.random.default_rng(1)
    noise_perf = rng.normal(size=(20, 1600)).T
    pbo_noise, logits_noise = cscv_pbo(noise_perf, n_groups=16)
    assert 0.3 <= pbo_noise <= 0.7

    planted = np.zeros((160, 2))
    group_size = 10
    for g in range(16):
        start = g * group_size
        end = (g + 1) * group_size
        if g % 2 == 0:
            planted[start:end, 0] = 1.0
            planted[start:end, 1] = -1.0
        else:
            planted[start:end, 0] = -1.0
            planted[start:end, 1] = 1.0
    pbo_planted, logits_planted = cscv_pbo(planted, n_groups=16)
    assert pbo_planted > 0.9

    assert len(logits_noise) == 12870
    assert len(logits_dom) == 12870
    assert len(logits_planted) == 12870


def test_random_entry_null():
    eligible = {
        "BTC": np.arange(0, 500, 2),
        "ETH": np.arange(0, 500, 3),
    }
    n_by_symbol = {"BTC": 15, "ETH": 10}
    hold_bars = 10
    side_share = 0.65

    recorded_draws = []

    def evaluate(entries: list[tuple[str, int, str]]) -> float:
        recorded_draws.append(entries)
        return float(len(entries))

    seed = 42
    null = random_entry_null(
        evaluate=evaluate,
        eligible=eligible,
        n_by_symbol=n_by_symbol,
        hold_bars=hold_bars,
        side_share=side_share,
        n_draws=2000,
        seed=seed,
    )

    total_entries = 0
    total_long = 0
    for entries in recorded_draws:
        btc_entries = [e for e in entries if e[0] == "BTC"]
        eth_entries = [e for e in entries if e[0] == "ETH"]
        assert len(btc_entries) == 15
        assert len(eth_entries) == 10

        btc_bars = sorted(e[1] for e in btc_entries)
        eth_bars = sorted(e[1] for e in eth_entries)
        assert np.all(np.diff(btc_bars) >= hold_bars)
        assert np.all(np.diff(eth_bars) >= hold_bars)

        for e in entries:
            total_entries += 1
            if e[2] == "long":
                total_long += 1

    observed_long_share = total_long / total_entries
    assert abs(observed_long_share - side_share) < 0.05

    obs = 25.0
    hand_p = (1.0 + sum(1 for x in null if x >= obs)) / (1.0 + len(null))
    assert p_value(obs, null) == hand_p


def test_circular_block_shuffle():
    values = np.arange(30)
    block_len = 5
    shuffled1 = circular_block_shuffle(values, block_len=block_len, rng=42)
    shuffled2 = circular_block_shuffle(values, block_len=block_len, rng=42)

    assert np.array_equal(shuffled1, shuffled2)
    assert np.array_equal(np.sort(shuffled1), values)

    for i in range(0, len(shuffled1), block_len):
        block = shuffled1[i : i + block_len]
        assert np.all(block[1:] == (block[:-1] + 1) % 30)

    values_2d = np.arange(30).reshape(10, 3)
    shuffled_2d = circular_block_shuffle(values_2d, block_len=2, rng=42)
    assert shuffled_2d.shape == values_2d.shape
    for row in shuffled_2d:
        assert np.any(np.all(values_2d == row, axis=1))


def test_shuffled_label_null():
    labels_by_symbol = {
        "BTC": np.array([1, 0, 1, 0, 1, 0, 1, 0, 1, 0] * 5),
    }

    p_values = []
    for s in range(200):
        rng_seed = np.random.default_rng(s)
        noise_returns = rng_seed.normal(0.0, 1.0, size=50)

        def run_pipeline(shuffled: dict[str, np.ndarray], noise=noise_returns) -> float:
            return float(np.dot(shuffled["BTC"], noise))

        observed = run_pipeline(labels_by_symbol)
        null = shuffled_label_null(
            run_pipeline=run_pipeline,
            labels_by_symbol=labels_by_symbol,
            block_len=5,
            n_perm=19,
            seed=s,
        )
        assert len(null) == 19
        pv = p_value(observed, null)
        p_values.append(pv)

    mean_pv = float(np.mean(p_values))
    assert 0.4 <= mean_pv <= 0.6
