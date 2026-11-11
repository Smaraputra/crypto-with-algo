"""End-to-end tests for lighter/run.py on synthetic panels: zero drift and a planted edge in both microstructure modes,
the source guard, the two noise runs, the report, the confirmation run with its one-time record, the point-in-time
universe and the command line. Everything is generated under tmp_path."""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import gzip
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest

from lighter import data, lock, run, stats
from lighter.data import DataError, DataReader, read_json
from lighter.fold_trades import day_start_ms
from lighter.synthetic import PanelSpec, make_panel, random_minute_data, rewrite_binance_wrong_asset

PLANTED = "F1-k1-th1.5-h60-time-AB"
JULY_END = dt.date(2025, 7, 31)


def args_for(panel, out, **extra):
    return argparse.Namespace(
        fold_dir=panel.fold_dir,
        binance_dir=panel.binance_dir,
        funding_dir=panel.funding_dir,
        out_dir=out,
        **extra,
    )


def build(tmp_path_factory, name, last_date=None, configs=None, **spec):
    root = tmp_path_factory.mktemp(name)
    panel = make_panel(root, PanelSpec(**spec))
    out = root / "out"
    path = run.cmd_dev(args_for(panel, out), last_date=last_date or panel.last_date, configs=configs)
    return panel, out, read_json(path)


def f1_configs(holds=(15, 60), thetas=(1.0, 1.5), ks=(1, 3)):
    return [
        c
        for c in lock.GRID
        if c.family == "F1"
        and c.exit == "time"
        and c.universe == "AB"
        and c.hold in holds
        and c.signal.p("theta") in thetas
        and c.signal.p("k") in ks
    ]


def by_id(result):
    return {c["id"]: c for c in result["configs"]}


@pytest.fixture(scope="module")
def zero(tmp_path_factory):
    return build(tmp_path_factory, "zero", n_markets=6, days=31, seed=12)


@pytest.fixture(scope="module")
def planted(tmp_path_factory):
    """July is the development span, the first fortnight of August is used as the confirmation span."""
    return build(tmp_path_factory, "planted", last_date=JULY_END, n_markets=6, days=45, seed=21, edge_bps=4.4)


@pytest.fixture(scope="module")
def zero_micro(tmp_path_factory):
    cfgs = f1_configs()
    return (*build(tmp_path_factory, "zero2", configs=cfgs, n_markets=4, days=31, seed=5, micro=True), cfgs)


@pytest.fixture(scope="module")
def planted_micro(tmp_path_factory):
    cfgs = f1_configs(holds=(60,), thetas=(1.5,), ks=(1,))
    return (
        *build(tmp_path_factory, "planted2", configs=cfgs, n_markets=6, days=31, seed=9, micro=True, edge_bps=4.4),
        cfgs,
    )


# ----------------------------------------------------------------------------------------------------------------
# Zero drift and a planted edge, microstructure mode 1


def test_zero_drift_panel_has_no_passing_configuration(zero):
    _, _, result = zero
    assert len(result["configs"]) == 2064
    flags = [stats.dev_flags(c, 0.0, 0.0) for c in result["configs"]]
    assert not any(f["pass"] for f in flags)
    # 2,064 correlated configurations on one month: the best t of pure noise can pass 3 (hence the noise bar and the
    # 2,000 trade item) but stays far below a real edge
    assert max(c["t"] for c in result["configs"]) < 5.0
    assert sum(c["trades"] > 0 for c in result["configs"]) > 1500
    rows = result["eligibility"]["months"]["2025-07"]["eligible"]
    assert [r["symbol"] for r in rows] == ["BTC", "ETH", "SOL", "XRP", "DOGE", "XAU"]
    assert [r["tier"] for r in rows] == ["A", "A", "A", "B", "B", "B"]
    assert [round(r["spread_proxy_bps"], 2) for r in rows] == [0.8, 0.8, 0.8, 2.0, 2.0, 2.0]
    assert [r["source"] for r in rows] == ["source pending guard"] * 5 + ["lighter"]
    guard = result["source_guard"]
    assert set(guard) == {f"{i}:2025-07" for i in range(1, 6)} and all(g["ok"] for g in guard.values())
    assert result["eligibility_sha256"] == run.content_hash(result["eligibility"])


def test_results_record_provenance_and_the_source_split(zero):
    _, out, result = zero
    assert result["lock_sha256"] == lock.lock_digest() and result["synthetic"] is True
    assert "git_head" in result and result["ledger_id"] == "lighter-l1" and result["trials"] == 2064
    assert set(result["versions"]) == {"numpy", "pandas", "pyarrow"} and "git_source" in result
    f2 = by_id(result)["F2-k1-th1.0-h15-time-AB"]
    assert set(f2["by_class"]) <= {"crypto", "tradfi"} and f2["by_class"]["crypto"]["trades"] > 0
    assert sum(v["trades"] for v in f2["by_class"].values()) == f2["trades"]
    assert "by_class" not in by_id(result)["F1-k1-th1.0-h15-time-AB"]
    for c in result["configs"][:300]:
        if c["trades"]:
            assert 0.0 <= c["tie_share"] <= 1.0 and c["mean_fill_cost_bps"] > 0.3
            assert c["majority_source"] in ("binance", "lighter")
    text = (out / "dev_result.json").read_text()
    assert text.count("generated_at") == 1 and "elapsed" not in text
    for c in result["configs"][:200]:
        b, lg = c["by_source"]["binance"]["trades"], c["by_source"]["lighter"]["trades"]
        assert b + lg == c["trades"]
    # XAU is the only Lighter-sourced market: a config that trades only XAU has no binance trades
    f5 = by_id(result)["F5-th2-plain-h15-time-AB"]
    assert f5["by_source"]["lighter"]["trades"] == 0  # F5 exists only on Binance months
    # F4 trigger rate. With a continuous input about 2 (1 - q) of the evaluable points fire (the upper and the lower
    # tail). The Lighter size-band inputs are tie-heavy (I is often exactly +1 or -1 when only one side printed in the
    # band), the quantile of the reference then equals 1 and "I >= quantile" fires on every tie: that is the rule as
    # specified, and it can only add firing, never remove it.
    checked = 0
    for c in result["configs"]:
        if c["family"] != "F4" or c["universe"] != "AB" or c["trigger_valid_points"] <= 5000:
            continue
        q = float(c["signal"].split("-q")[1].split("-")[0])
        nominal = 2 * (1 - q)
        assert c["trigger_rate"] > nominal - 0.08, c["id"]
        if c["signal"].startswith(("F4-binance", "F4-small")):
            assert abs(c["trigger_rate"] - nominal) < 0.08, c["id"]
            checked += 1
    assert checked >= 4


def test_zero_drift_f1_nets_minus_the_spread(zero, tmp_path):
    panel, _, _ = zero
    cfgs = [c for c in lock.GRID if c.family == "F1" and c.exit == "time" and c.universe == "AB"]
    out = tmp_path / "out"
    run.cmd_dev(args_for(panel, out, save_trades=True), last_date=panel.last_date, configs=cfgs)
    means, zs, excess = [], [], []
    for c in cfgs:
        files = sorted((out / "trades" / c.cid).glob("market_*.parquet"))
        tables = [pq.read_table(f) for f in files]
        net = np.concatenate([t.column("net").to_numpy() for t in tables]) * 1e4
        cost = np.concatenate(
            [np.full(t.num_rows, 2 * panel.half_spreads_bps[int(t["market_id"][0].as_py())]) for t in tables]
        )
        means.append(net.mean())
        if c.hold <= 60:
            excess.append(net.mean() + cost.mean())
        zs.append((net + cost).mean() / ((net + cost).std() / np.sqrt(len(net))))
    assert -2.0 < float(np.mean(means)) < -0.8
    assert abs(float(np.mean(excess))) < 0.5
    assert max(abs(z) for z in zs) < 4.0
    t = pq.read_table(next((out / "trades" / cfgs[3].cid).glob("market_1.parquet")))
    d = t.to_pydict()
    for i in range(min(50, t.num_rows)):
        side = d["side"][i]
        assert d["gross"][i] == pytest.approx(side * np.log(d["exit_px"][i] / d["entry_px"][i]))
        assert d["net"][i] == pytest.approx(d["gross"][i] - d["fund"][i])
        assert d["entry_ts"][i] >= d["decision_ms"][i] + 500
        assert d["exit_ts"][i] > d["entry_ts"][i]


def test_planted_edge_passes_all_items_but_the_month_count_which_a_one_month_panel_cannot_meet(planted, monkeypatch):
    _, _, result = planted
    c = by_id(result)[PLANTED]
    flags = stats.dev_flags(c, 0.0, 0.0)
    assert flags["a"] and flags["b"] and flags["d"] and flags["e"] and flags["f"]
    assert not flags["c"] and c["months_with_trades"] == 1  # item (c) needs 6 months with trades
    monkeypatch.setattr(lock, "PASS_MIN_MONTHS_WITH_TRADES", 1)
    assert stats.dev_flags(c, 0.0, 0.0)["pass"]
    assert 1.5 < c["mean_net_bps"] < 5.0 and c["t"] > 3.0
    # item (d) asks for 60% of the markets positive, not all of them: a tier B market can sit below zero by noise
    assert c["markets_100"] == 6 and c["pos_market_share"] >= lock.PASS_MIN_MARKET_SHARE
    # the best t's belong to the planted reversal (F1 k 1 theta 1.5 hold 60) or to configurations that share its effect
    ranked = sorted(result["configs"], key=lambda r: -r["t"])
    assert sum(r["id"].startswith("F1-k1-th1.5-h60") for r in ranked[:4]) >= 2


# ----------------------------------------------------------------------------------------------------------------
# Microstructure mode 2


def test_mode_2_zero_drift_nets_minus_the_spread(zero_micro, tmp_path):
    panel, _, result, cfgs = zero_micro
    rows = result["eligibility"]["months"]["2025-07"]["eligible"]
    assert len(rows) == 4 and all(r["qualifying_minutes"] >= 1000 for r in rows), rows
    out = tmp_path / "out"
    run.cmd_dev(args_for(panel, out, save_trades=True), last_date=panel.last_date, configs=cfgs)
    zs = []
    for c in cfgs:
        tables = [pq.read_table(f) for f in sorted((out / "trades" / c.cid).glob("market_*.parquet"))]
        net = np.concatenate([t.column("net").to_numpy() for t in tables]) * 1e4
        proxy = np.concatenate(
            [np.full(t.num_rows, rows[int(t["market_id"][0].as_py()) - 1]["spread_proxy_bps"]) for t in tables]
        )
        se = net.std() / np.sqrt(len(net))
        zs.append((net.mean() + proxy.mean()) / se)
        print(f"{c.cid}: mean {net.mean():.2f} bps, minus spread {-proxy.mean():.2f}, se {se:.2f}")
    assert np.mean(zs) > -2.5 and max(abs(z) for z in zs) < 4.0


def test_mode_2_planted_edge_is_found(planted_micro):
    _, _, result, cfgs = planted_micro
    c = by_id(result)[PLANTED]
    assert c["trades"] > 1000 and c["mean_net_bps"] > 1.0 and c["t"] > 3.0 and c["markets_100"] == 6


# ----------------------------------------------------------------------------------------------------------------
# Determinism


def test_two_runs_give_identical_hashes_and_trade_files(tmp_path):
    panel = make_panel(tmp_path / "p", PanelSpec(n_markets=3, days=12, seed=5, edge_bps=5.0))
    cfgs = [c for c in lock.GRID if c.signal.sig_id in ("F1-k1-th1.5", "F4-small-k3-q0.8-follow", "F6-th1-x10")]
    paths = []
    for name in ("a", "b"):
        paths.append(
            run.cmd_dev(args_for(panel, tmp_path / name, save_trades=True), last_date=panel.last_date, configs=cfgs)
        )
    a, b = (json.loads(p.read_text()) for p in paths)
    assert a["content_sha256"] == b["content_sha256"]
    assert {k: v for k, v in a.items() if k != "generated_at"} == {k: v for k, v in b.items() if k != "generated_at"}
    assert run.content_hash(a) == a["content_sha256"]
    files_a = sorted((tmp_path / "a" / "trades").rglob("*.parquet"))
    files_b = sorted((tmp_path / "b" / "trades").rglob("*.parquet"))
    assert files_a and [f.relative_to(tmp_path / "a") for f in files_a] == [
        f.relative_to(tmp_path / "b") for f in files_b
    ]
    for fa, fb in zip(files_a, files_b, strict=True):
        assert hashlib.sha256(fa.read_bytes()).hexdigest() == hashlib.sha256(fb.read_bytes()).hexdigest()


def test_manifest_lists_every_file_read_and_nothing_beyond_the_end(zero):
    panel, _, result = zero
    manifest = result["manifest"]
    fold = {k: v for k, v in manifest.items() if k.startswith("fold/")}
    for key, digest in list(fold.items())[:5]:
        if "date=" in key:
            assert hashlib.sha256((panel.fold_dir / "v1" / key.split("/", 1)[1]).read_bytes()).hexdigest() == digest
    days = sorted(k.split("date=")[1][:10] for k in fold if "date=" in k)
    assert days[0] == "2025-06-01" and days[-1] == panel.last_date.isoformat()
    assert {"fold/markets.json", "fold/manifest.jsonl", "funding/market_1.parquet"} <= set(manifest)
    assert not any("2025-09" in k or "2026" in k for k in manifest if k.startswith("binance/"))


# ----------------------------------------------------------------------------------------------------------------
# The source guard


def _month_md(binance_scale=1.0, wrong=False, seed=3):
    md = random_minute_data(run.Market("BTC", 1, 4), day_start_ms(dt.date(2025, 6, 1)), 30, seed=seed)
    if wrong:
        rng = np.random.default_rng(seed + 1)
        md.b_close = 100.0 * np.exp(np.cumsum(rng.normal(0, 3e-4, md.n)))
    md.b_close = md.b_close * binance_scale
    return md


def test_guard_passes_the_same_asset_and_fails_a_wrong_asset_a_level_gap_and_too_few_points():
    ok = run.guard_month(_month_md())
    assert ok["ok"] and ok["corr"] > 0.5 and ok["return_points"] >= 2000 and abs(ok["median_bps"]) < 5
    wrong = run.guard_month(_month_md(wrong=True))
    assert not wrong["ok"] and abs(wrong["corr"]) < 0.5
    # the level gap: ln(L / B) = -ln(scale). 49 bps passes, 51 bps fails
    assert run.guard_month(_month_md(binance_scale=float(np.exp(0.0049))))["ok"]
    gap = run.guard_month(_month_md(binance_scale=float(np.exp(0.0051))))
    assert not gap["ok"] and gap["corr"] > 0.5
    md = _month_md()
    few = md.slice(0, 5 * 1440)  # five days: about 1,400 grid points, under the 2,000 needed
    g = run.guard_month(few)
    assert g["return_points"] < 2000 and not g["ok"]


def test_a_wrong_asset_ticker_falls_back_to_lighter_in_the_run(tmp_path):
    panel = make_panel(tmp_path / "p", PanelSpec(n_markets=4, days=8, seed=14, edge_bps=0.0))
    rewrite_binance_wrong_asset(panel, "ETHUSDT")
    cfgs = [
        c for c in lock.GRID if c.signal.sig_id in ("F1-k1-th1.0", "F5-th2-plain") and c.hold == 15 and c.exit == "time"
    ]
    path = run.cmd_dev(args_for(panel, tmp_path / "o"), last_date=panel.last_date, configs=cfgs)
    res = read_json(path)
    assert res["source_guard"]["2:2025-07"]["ok"] is False and res["source_guard"]["1:2025-07"]["ok"] is True
    assert res["markets"]["2"]["binance_months"] == 0 and res["markets"]["1"]["binance_months"] == 1
    f5 = by_id(res)["F5-th2-plain-h15-time-AB"]
    assert "2" not in {k for k, v in f5["per_market"].items() if v["trades"]}  # no F5 on the wrong ticker
    eligibility = read_json(run.cmd_eligibility(args_for(panel, tmp_path / "e"), last_date=panel.last_date))
    rows = {r["symbol"]: r["source"] for r in eligibility["months"]["2025-07"]["eligible"]}
    assert rows["ETH"] == "source pending guard"  # the eligibility command does not read Binance content


def test_the_spread_proxy_in_force_is_carried_forward():
    span = run.Span(dt.date(2025, 7, 1), dt.date(2025, 9, 30))
    proxies = {(2025, 7): {1: 0.8}, (2025, 8): {}, (2025, 9): {1: 3.0}}
    sp = run.sp_per_minute(proxies, 1, span)
    t0 = span.t0_ms
    minute = lambda d: (day_start_ms(d) - t0) // 60_000  # noqa: E731
    assert sp[minute(dt.date(2025, 7, 15))] == 0.8
    assert sp[minute(dt.date(2025, 8, 15))] == 0.8  # August has none: July's is carried forward
    assert sp[minute(dt.date(2025, 9, 15))] == 3.0
    assert np.isnan(sp[0])  # the warm-up days precede the first month with a proxy: no proxy, no fill
    late = {(2025, 8): {1: 1.5}}
    sp_late = run.sp_per_minute(late, 1, span)
    # before the first month with a proxy there is none: such minutes cannot carry a fill
    assert np.isnan(sp_late[minute(dt.date(2025, 7, 10))]) and np.isnan(sp_late[0])
    assert sp_late[minute(dt.date(2025, 8, 10))] == 1.5


# ----------------------------------------------------------------------------------------------------------------
# Noise runs


def prov_of(panel):
    return run.provenance(panel.fold_dir)


def test_null_seed_writes_a_shift_file_and_an_f6_file(planted, tmp_path):
    panel, dev_out, dev = planted
    cfgs = [
        c for c in lock.GRID if c.signal.sig_id in ("F1-k1-th1.5", "F6-th1-x10", "F6-th2-x10") and c.hold in (10, 60)
    ]
    out = tmp_path / "out"
    out.mkdir()
    (out / "dev_result.json").write_text((dev_out / "dev_result.json").read_text())
    shift_path, f6_path = run.cmd_null(args_for(panel, out, seed=3), last_date=JULY_END, configs=cfgs)
    shift, f6 = read_json(shift_path), read_json(f6_path)
    prov = prov_of(panel)
    run.check_result_file(shift, "shift", prov)
    run.check_result_file(f6, "f6", prov)
    assert shift["seed"] == 3 and shift["offset_days"] == lock.noise_offsets()[2]
    assert all(not k.startswith("F6") for k in shift["t_by_config"]) and shift["t_by_config"]
    assert f6["offset_days"] is None and f6["t_by_config"] and all(k.startswith("F6") for k in f6["t_by_config"])
    assert shift["max_t"] == max(shift["t_by_config"].values()) and f6["max_t"] == max(f6["t_by_config"].values())
    assert shift["t_by_config"][PLANTED] < 3.0 < by_id(dev)[PLANTED]["t"]  # the shift kills the planted edge
    assert shift["eligibility_sha256"] == dev["eligibility_sha256"]
    with pytest.raises(SystemExit):
        run.cmd_null(args_for(panel, out, seed=21), last_date=JULY_END)


def _grid_inputs(panel, last_date=JULY_END):
    reader = DataReader(
        fold_dir=panel.fold_dir,
        binance_dir=panel.binance_dir,
        funding_dir=panel.funding_dir,
        mode="dev",
        last_date=last_date,
    )
    span = run.Span(lock.DEV_FIRST_DATE, last_date)
    return reader, span, run.prepare(reader, span)


def test_a_zero_day_shift_changes_nothing_and_a_sign_flip_is_seeded(planted):
    panel, _, dev = planted
    reader, span, prep = _grid_inputs(panel)
    ids = (
        "F1-k1-th1.5-h60-time-AB",
        "F4-large-k3-q0.9-fade-h15-target1-A",
        "F2-k3-th1.0-h30-time-AB",
        "F6-th1-x10-time-AB",
    )
    cfgs = [lock.CONFIG_BY_ID[i] for i in ids]

    def go(**kw):
        return run.run_grid(reader, prep.markets, prep.elig, prep.proxies, cfgs, span, **kw)[0]

    def core(results):
        """The trigger rate is measured on the real run only (a shifted or flipped run has no real trigger rate)."""
        return [{k: v for k, v in r.items() if k not in ("trigger_rate", "trigger_valid_points")} for r in results]

    plain, zero_shift, shifted = go(), go(shift_days=0), go(shift_days=7)
    assert plain[1]["trigger_rate"] is not None and zero_shift[1]["trigger_rate"] is None
    assert core(plain) == core(zero_shift) and core(plain) != core(shifted)
    assert [p["trades"] for p in plain] == [by_id(dev)[c.cid]["trades"] for c in cfgs]
    a, b, c = go(signflip_seed=1), go(signflip_seed=1), go(signflip_seed=2)
    assert a == b and a != c
    for k in range(3):  # the sign flip touches F6 only
        assert core([a[k]]) == core([plain[k]])
    assert a[3] != plain[3]


def test_mirror_and_doubled_spread_runs(planted):
    panel, _, dev = planted
    reader, span, prep = _grid_inputs(panel)
    cfgs = [lock.CONFIG_BY_ID[PLANTED]]

    def go(**kw):
        return run.run_grid(reader, prep.markets, prep.elig, prep.proxies, cfgs, span, **kw)[0][0]

    base, mirror, doubled = go(), go(mirror=True), go(spread_mult=2.0)
    assert base["trades"] == by_id(dev)[PLANTED]["trades"]
    assert mirror["mean_net_bps"] < 0 < base["mean_net_bps"]
    diag = (base["mean_net_bps"] - mirror["mean_net_bps"]) / 2
    assert diag > 1.0  # the planted reversal is directional edge
    assert 0.6 < base["mean_net_bps"] - doubled["mean_net_bps"] < 2.4  # about one more spread (0.8 to 2.0 bps)
    assert doubled["mean_net_bps"] > 0


# ----------------------------------------------------------------------------------------------------------------
# Report and confirm


def write_nulls(out: Path, prov, shift_max, f6_max, seeds=lock.NOISE_SEEDS):
    for seed, a, b in zip(seeds, shift_max, f6_max, strict=True):
        for kind, m, off in (("shift", a, lock.noise_offsets()[seed - 1]), ("f6", b, None)):
            run.write_result(
                out / f"null_{kind}_{seed}.json",
                {"kind": f"null_{kind}", **prov, "seed": seed, "offset_days": off, "max_t": m, "t_by_config": {}},
            )


def copy_dev(dev_out, dest):
    dest.mkdir(parents=True, exist_ok=True)
    (dest / "dev_result.json").write_text((dev_out / "dev_result.json").read_text())
    return dest


def write_audit(records: Path, ids):
    records.mkdir(parents=True, exist_ok=True)
    (records / run.SUSPECT_FILE).write_text(json.dumps([{"id": i, "note": "audited in the test"} for i in ids]))


@pytest.fixture
def relaxed(planted, monkeypatch, tmp_path):
    """One-month panels cannot meet item (c). SUSPECT planted configurations are cleared by an audit file."""
    _, _, dev = planted
    monkeypatch.setattr(lock, "PASS_MIN_MONTHS_WITH_TRADES", 1)
    records = tmp_path / "records"
    monkeypatch.setattr(run, "RECORDS_DIR", records)
    write_audit(records, [c["id"] for c in dev["configs"] if stats.is_suspect(c)])
    return dev


def test_report_finalists_variant_checks_and_account_layer(planted, tmp_path, relaxed, capsys):
    panel, dev_out, dev = planted
    out = copy_dev(dev_out, tmp_path / "rep")
    write_nulls(out, prov_of(panel), [2.0 + 0.1 * i for i in range(20)], [1.0] * 20)
    capsys.readouterr()
    rep = read_json(run.cmd_report(args_for(panel, out), last_date=JULY_END))
    assert capsys.readouterr().out.startswith(lock.REPORT_CAUTION)  # the caution comes first in the output
    assert rep["caution"] == lock.REPORT_CAUTION and lock.REPORT_CAUTION.startswith("Development statistics")
    assert rep["noise_bar"] == pytest.approx(3.9) and rep["f6_bar"] == 1.0  # the LARGEST maxima
    assert rep["pass_threshold_t"] == pytest.approx(3.9)
    assert PLANTED in rep["passing"] and PLANTED in rep["candidates"]
    fin = rep["finalists"]
    assert 1 <= len(fin) <= 3 and len({f["family"] for f in fin}) == len(fin)
    top = fin[0]["config_id"]
    assert top.startswith("F1-k1-th1.5-h60")
    checks = rep["variant_checks"][top]
    assert checks["mirror_ok"] and checks["doubled_ok"] and checks["mirror_diagnostic_bps"] > 0
    assert checks["mean_mirror_bps"] < 0 < checks["mean_cfg_bps"] and checks["mean_doubled_spread_bps"] > 0
    doc = read_json(out / "finalists.json")
    assert doc["lock_sha256"] == lock.lock_digest() and doc["dev_result_sha256"] == dev["content_sha256"]
    assert doc["finalists"][0]["mirror_diagnostic_bps"] == checks["mirror_diagnostic_bps"]
    assert rep["rerun_matches_dev"] == {f["config_id"]: True for f in fin}
    acct = rep["account_layer"][top]
    assert set(acct) == {"L3", "L10", "L20"} and all(isinstance(a["liquidated"], bool) for a in acct.values())
    assert rep["prediction"] == lock.PREDICTION
    assert "by_source" in rep["configs"][0] and "f" in rep["configs"][0]


def test_a_suspect_configuration_is_not_a_finalist_until_cleared(planted, tmp_path, monkeypatch):
    panel, dev_out, dev = planted
    suspects = [c["id"] for c in dev["configs"] if stats.is_suspect(c)]
    monkeypatch.setattr(lock, "PASS_MIN_MONTHS_WITH_TRADES", 1)
    monkeypatch.setattr(run, "RECORDS_DIR", tmp_path / "no_records")  # no audit file: nothing is cleared
    out = copy_dev(dev_out, tmp_path / "rep")
    write_nulls(out, prov_of(panel), [2.0] * 20, [1.0] * 20)
    rep = read_json(run.cmd_report(args_for(panel, out), last_date=JULY_END))
    assert set(rep["tripwire"]["suspect"]) == set(suspects)
    assert not set(suspects) & {f["config_id"] for f in rep["finalists"]}
    assert ("audit for look-ahead" in rep["tripwire"]["notice"]) == bool(suspects)
    assert rep["tripwire"]["cleared"] == [] and rep["tripwire"]["cleared_file_sha256"] is None
    # clearing them by an audit file OUTSIDE lighter/ lets them through, and the file's hash is recorded
    if suspects:
        write_audit(tmp_path / "records", suspects)
        monkeypatch.setattr(run, "RECORDS_DIR", tmp_path / "records")
        rep2 = read_json(run.cmd_report(args_for(panel, out), last_date=JULY_END))
        assert set(rep2["tripwire"]["cleared"]) == set(suspects)
        assert rep2["tripwire"]["cleared_file_sha256"] == run._sha256_file(tmp_path / "records" / run.SUSPECT_FILE)
        assert read_json(out / "finalists.json")["suspect_cleared_sha256"] == rep2["tripwire"]["cleared_file_sha256"]
        assert set(rep["candidates"]) <= set(rep2["candidates"])  # clearing can only add candidates


def test_report_with_a_high_noise_bar_has_no_finalists(planted, tmp_path, relaxed):
    panel, dev_out, _ = planted
    out = copy_dev(dev_out, tmp_path / "rep")
    write_nulls(out, prov_of(panel), [50.0] * 20, [50.0] * 20)
    rep = read_json(run.cmd_report(args_for(panel, out), last_date=JULY_END))
    assert rep["passing"] == [] and rep["finalists"] == [] and rep["account_layer"] == {}


def test_report_refusals(planted, tmp_path, relaxed, git_free):
    panel, dev_out, dev = planted
    prov = prov_of(panel)
    out = copy_dev(dev_out, tmp_path / "a")
    write_nulls(out, prov, [2.0] * 19, [1.0] * 19, seeds=lock.NOISE_SEEDS[:19])
    with pytest.raises(SystemExit, match="missing null"):
        run.cmd_report(args_for(panel, out), last_date=JULY_END)
    write_nulls(out, prov, [2.0], [1.0], seeds=lock.NOISE_SEEDS[19:])
    # a tampered null file fails its content hash
    p = out / "null_shift_4.json"
    doc = json.loads(p.read_text())
    doc["max_t"] = 0.0
    p.write_text(json.dumps(doc))
    with pytest.raises(SystemExit, match="content hash"):
        run.cmd_report(args_for(panel, out), last_date=JULY_END)
    # a null file from another lock digest
    run.write_result(
        p, {**{k: v for k, v in doc.items() if k not in ("generated_at", "content_sha256")}, "lock_sha256": "0" * 64}
    )
    with pytest.raises(SystemExit, match="different lock digest"):
        run.cmd_report(args_for(panel, out), last_date=JULY_END)
    # a re-run that differs from the dev result stops the report
    out2 = copy_dev(dev_out, tmp_path / "b")
    write_nulls(out2, prov, [2.0] * 20, [1.0] * 20)
    forged = json.loads((out2 / "dev_result.json").read_text())
    for c in forged["configs"]:
        if c["trades"]:  # whichever configurations are finalists, their re-run now differs from the recorded result
            c["trades"] += 1
    run.write_result(out2 / "dev_result.json", {k: v for k, v in forged.items() if k != "content_sha256"})
    with pytest.raises(SystemExit, match="differs from the development result"):
        run.cmd_report(args_for(panel, out2), last_date=JULY_END)
    # synthetic and non-synthetic files cannot be mixed
    out3 = copy_dev(dev_out, tmp_path / "c")
    write_nulls(out3, {**prov, "synthetic": False}, [2.0] * 20, [1.0] * 20)
    with pytest.raises(SystemExit, match="synthetic"):
        run.cmd_report(args_for(panel, out3), last_date=JULY_END)


@pytest.fixture
def git_free(monkeypatch):
    monkeypatch.setattr(run, "_git", lambda args: "abc\n" if args[0] == "rev-parse" else "")


def confirm_setup(planted, tmp_path, monkeypatch):
    """A dev dir with the dev result, 20 + 20 null files and finalists.json, and the confirm span set to August."""
    panel, dev_out, _ = planted
    monkeypatch.setattr(lock, "CONFIRM_FIRST_DATE", dt.date(2025, 8, 1))
    monkeypatch.setattr(lock, "CONFIRM_MONTHS", ((2025, 8), (2025, 9), (2025, 10), (2025, 11)))
    dev_dir = copy_dev(dev_out, tmp_path / "dev")
    write_nulls(dev_dir, prov_of(panel), [2.0] * 20, [1.0] * 20)
    run.cmd_report(args_for(panel, dev_dir), last_date=JULY_END)
    return panel, dev_dir


def confirm_args(panel, dev_dir, out, finalists=None, **flags):
    return args_for(panel, out, finalists=str(finalists or dev_dir / "finalists.json"), dev_dir=str(dev_dir), **flags)


def prepare_confirm(panel, dev_dir, finalists=None, out=None):
    """A synthetic record lives in the out dir, so --run must use the out dir that --prepare used."""
    return run.cmd_confirm(
        confirm_args(panel, dev_dir, out or dev_dir, finalists, prepare=True, run=False), dev_last_date=JULY_END
    )


def confirm_files(panel, out):
    return run.confirm_paths(prov_of(panel), out)


def run_confirm(panel, dev_dir, out, finalists=None):
    args = confirm_args(panel, dev_dir, out, finalists, prepare=False, run=True)
    return run.cmd_confirm(args, last_date=dt.date(2025, 8, 14), dev_last_date=JULY_END)


def test_confirm_prepare_writes_the_record_and_stops_and_run_needs_it(planted, tmp_path, relaxed, monkeypatch):
    panel, dev_dir = confirm_setup(planted, tmp_path, monkeypatch)
    ids = [f["config_id"] for f in read_json(dev_dir / "finalists.json")["finalists"]]
    assert ids
    with pytest.raises(SystemExit, match="no confirm record"):
        run_confirm(panel, dev_dir, tmp_path / "early")
    assert not (run.RECORDS_DIR / "confirm_record.json").exists()
    with pytest.raises(SystemExit, match="exactly one of"):
        run.cmd_confirm(confirm_args(panel, dev_dir, tmp_path / "x", prepare=True, run=True))
    with pytest.raises(SystemExit, match="exactly one of"):
        run.cmd_confirm(confirm_args(panel, dev_dir, tmp_path / "x", prepare=False, run=False))
    record_path = prepare_confirm(panel, dev_dir)
    # a synthetic rehearsal never touches records/: its record sits in the out dir with a synthetic suffix
    assert record_path == dev_dir / "confirm_record.synthetic.json"
    assert not (run.RECORDS_DIR / "confirm_record.json").exists()
    record = read_json(record_path)
    assert record["finalists"] == ids and record["ran"] is False and record["lock_sha256"] == lock.lock_digest()
    assert record["dev_hashes"]["dev_result.json"] == read_json(dev_dir / "dev_result.json")["content_sha256"]
    assert len(record["dev_hashes"]) == 41  # the dev result and 20 + 20 null files
    assert not (tmp_path / "confirm").exists() and not list(dev_dir.glob("confirm_result.json"))  # prepare stops
    with pytest.raises(SystemExit, match="exists already"):
        prepare_confirm(panel, dev_dir)


def test_confirm_run_checks_finalists_runs_once_and_applies_holm(planted, tmp_path, relaxed, monkeypatch):
    panel, dev_dir = confirm_setup(planted, tmp_path, monkeypatch)
    ids = [f["config_id"] for f in read_json(dev_dir / "finalists.json")["finalists"]]
    out = tmp_path / "confirm"
    prepare_confirm(panel, dev_dir, out=out)
    res = read_json(run_confirm(panel, dev_dir, out))
    assert res["kind"] == "confirm" and [r["id"] for r in res["results"]] == ids
    assert res["holm_family_size"] == len(ids)
    rows = res["eligibility"]["months"]["2025-08"]["eligible"]
    assert len(rows) == 6 and list(res["eligibility"]["months"]) == ["2025-08"]
    r = res["results"][0]
    assert r["days"] == 14 and [m["month"] for m in r["months"]] == ["2025-08"]
    flags = r["confirm"]
    assert {
        "mean_positive",
        "p_one_sided",
        "months_ok",
        "checks_ok",
        "source_ok",
        "pre_holm_ok",
        "p_below_holm",
    } <= set(flags)
    assert flags["mirror_diagnostic_bps"] is not None and flags["mean_doubled_spread_bps"] is not None
    assert flags["mean_fill_cost_bps"] > 0 and flags["majority_source"] in ("binance", "lighter")
    assert flags["p_one_sided"] == pytest.approx(stats.normal_sf(r["t"]))
    assert not flags["months_ok"] and not flags["pass"]  # a fortnight of one month: at most 1 of 4 months positive
    paths = confirm_files(panel, out)
    record = read_json(paths.record)
    assert res["confirm_record_sha256"] == record["content_sha256"]
    marker = paths.marker
    assert marker.name.endswith(".synthetic.json") and marker.parent == out
    assert not list(run.RECORDS_DIR.glob("confirm_ran_*"))  # nothing consumed in records/
    marker_doc = read_json(marker)
    assert res["consumed_marker_sha256"] == marker_doc["content_sha256"]
    assert marker_doc["status"] == "started" and marker_doc["attempt"] == 1 and marker_doc["synthetic"] is True
    assert res["attempt"] == 1 and res["rerun_note_sha256"] is None and res["scale_policy"] == "exclude"
    pre = res["preflight"]
    assert pre["scale_breaks_found"] == [] and pre["funding_files_checked"] >= 1 and pre["binance_files_checked"] >= 1
    assert not any("2025-11" in k for k in res["manifest"] if k.startswith("fold/"))
    # one time only: the same out dir, another out dir, and a record that says it ran
    with pytest.raises(SystemExit, match="confirm runs once"):
        run_confirm(panel, dev_dir, out)
    with pytest.raises(SystemExit, match="no confirm record"):
        run_confirm(panel, dev_dir, tmp_path / "elsewhere")  # a synthetic record belongs to its own out dir
    marker.unlink()
    with pytest.raises(SystemExit, match="confirm runs once"):
        run_confirm(panel, dev_dir, out)  # the result already exists in this out dir
    record["ran"] = True
    (tmp_path / "third").mkdir()
    run.write_result(
        confirm_files(panel, tmp_path / "third").record, {k: v for k, v in record.items() if k != "content_sha256"}
    )
    with pytest.raises(SystemExit, match="confirm runs once"):
        run_confirm(panel, dev_dir, tmp_path / "third")


def test_confirm_refuses_a_different_finalists_list_a_tampered_file_and_a_tampered_null(
    planted, tmp_path, relaxed, monkeypatch
):
    panel, dev_dir = confirm_setup(planted, tmp_path, monkeypatch)
    fin = read_json(dev_dir / "finalists.json")
    base = {k: v for k, v in fin.items() if k not in ("generated_at", "content_sha256")}
    run.write_result(tmp_path / "empty.json", {**base, "finalists": []})
    with pytest.raises(SystemExit, match="differ from the supplied file"):
        prepare_confirm(panel, dev_dir, tmp_path / "empty.json")
    other = {**base, "finalists": [{"config_id": "F4-small-k3-q0.8-follow-h5-time-AB"}]}
    run.write_result(tmp_path / "other.json", other)
    with pytest.raises(SystemExit, match="differ from the supplied file"):
        prepare_confirm(panel, dev_dir, tmp_path / "other.json")
    forged = json.loads((dev_dir / "finalists.json").read_text())
    forged["noise_bar"] = 0.0  # edited without a new hash
    (tmp_path / "forged.json").write_text(json.dumps(forged))
    with pytest.raises(SystemExit, match="content hash"):
        prepare_confirm(panel, dev_dir, tmp_path / "forged.json")
    run.write_result(tmp_path / "lock.json", {**base, "lock_sha256": "0" * 64})
    with pytest.raises(SystemExit, match="different lock digest"):
        prepare_confirm(panel, dev_dir, tmp_path / "lock.json")
    # the audit file the finalists used must be the one on disk now
    run.write_result(tmp_path / "audit.json", {**base, "suspect_cleared_sha256": "0" * 64})
    with pytest.raises(SystemExit, match="audit file"):
        prepare_confirm(panel, dev_dir, tmp_path / "audit.json")
    p = dev_dir / "null_f6_2.json"
    doc = json.loads(p.read_text())
    doc["max_t"] = 99.0
    p.write_text(json.dumps(doc))
    with pytest.raises(SystemExit, match="content hash"):
        prepare_confirm(panel, dev_dir)
    assert not confirm_files(panel, dev_dir).record.exists()  # nothing was prepared


def test_confirm_run_refuses_when_the_dev_files_or_the_finalists_changed_after_prepare(
    planted, tmp_path, relaxed, monkeypatch
):
    panel, dev_dir = confirm_setup(planted, tmp_path, monkeypatch)
    prepare_confirm(panel, dev_dir)
    p = dev_dir / "null_shift_5.json"
    doc = json.loads(p.read_text())
    doc["max_t"] = 0.5
    run.write_result(p, {k: v for k, v in doc.items() if k != "content_sha256"})  # valid file, different content
    with pytest.raises(SystemExit, match="differ from the committed confirm record"):
        run_confirm(panel, dev_dir, dev_dir)
    assert not confirm_files(panel, dev_dir).marker.exists()


def test_confirm_rerun_on_the_development_data_must_match_the_dev_result(planted, tmp_path, relaxed, monkeypatch):
    panel, dev_dir = confirm_setup(planted, tmp_path, monkeypatch)
    ids = [f["config_id"] for f in read_json(dev_dir / "finalists.json")["finalists"]]
    prepare_confirm(panel, dev_dir)
    real = run.rerun_matches

    def forged(inputs):
        for c in inputs.dev["configs"]:
            if c["id"] in ids:
                c["trades"] += 1
        real(inputs)

    monkeypatch.setattr(run, "rerun_matches", forged)
    with pytest.raises(SystemExit, match="differs from the dev result"):
        run_confirm(panel, dev_dir, dev_dir)
    assert not confirm_files(panel, dev_dir).marker.exists()


def test_the_confirm_record_must_be_committed_on_real_data(tmp_path, monkeypatch):
    path = tmp_path / "confirm_record.json"
    path.write_text("{}")
    calls = []

    def fake(args):
        calls.append(args)
        return ""

    monkeypatch.setattr(run, "_git", fake)
    assert run.record_committed(path) is True and calls[0][0] == "ls-files" and calls[1][0] == "status"

    def untracked(args):
        raise subprocess.CalledProcessError(1, "git")

    monkeypatch.setattr(run, "_git", untracked)
    assert run.record_committed(path) is False
    monkeypatch.setattr(run, "_git", lambda a: " M x\n" if a[0] == "status" else "")
    assert run.record_committed(path) is False  # tracked but modified

    def no_git(args):
        raise OSError("no git")

    monkeypatch.setattr(run, "_git", no_git)
    monkeypatch.delenv("LIGHTER_RECORD_COMMITTED", raising=False)
    assert run.record_committed(path) is False
    monkeypatch.setenv("LIGHTER_RECORD_COMMITTED", "1")
    assert run.record_committed(path) is True


CONFIRM_LAST = dt.date(2025, 8, 14)


def test_confirm_files_are_separate_for_synthetic_and_real_runs(tmp_path, monkeypatch):
    monkeypatch.setattr(run, "RECORDS_DIR", tmp_path / "records")
    digest = "ab" * 32
    syn = run.confirm_paths({"synthetic": True, "lock_sha256": digest}, tmp_path / "o")
    real = run.confirm_paths({"synthetic": False, "lock_sha256": digest}, tmp_path / "o")
    assert syn.record.parent == syn.marker.parent == syn.note.parent == tmp_path / "o"
    assert all("synthetic" in p.name for p in (syn.record, syn.marker, syn.note))
    assert real.record == run.RECORDS_DIR / "confirm_record.json"
    assert real.marker == run.RECORDS_DIR / f"confirm_ran_{digest[:16]}.json"
    assert real.note == run.RECORDS_DIR / "lighter_l1_confirm_rerun_note.json"
    assert {syn.record, syn.marker, syn.note}.isdisjoint({real.record, real.marker, real.note})


def test_a_real_run_refuses_a_synthetic_record_or_marker(planted, tmp_path, monkeypatch):
    panel, _, _ = planted
    records = tmp_path / "records"
    monkeypatch.setattr(run, "RECORDS_DIR", records)
    prov = {**prov_of(panel), "synthetic": False}
    paths = run.confirm_paths(prov, tmp_path / "o")
    records.mkdir()
    args = argparse.Namespace(out_dir=tmp_path / "o")
    run.write_result(paths.record, {"kind": "confirm_record", **prov, "synthetic": True, "ran": False})
    with pytest.raises(SystemExit, match="synthetic"):
        run.confirm_run(args, prov, None, paths, None)
    run.write_result(paths.record, {"kind": "confirm_record", **prov, "ran": False, "finalists": []})
    run.write_result(paths.marker, {"kind": "confirm_ran", **prov, "synthetic": True, "status": "started"})
    with pytest.raises(SystemExit, match="synthetic"):
        run.confirm_run(args, prov, None, paths, None)


def copy_panel(panel, dest: Path):
    """A private copy of the fold, Binance and funding directories, so a test can damage them."""
    dest.mkdir(parents=True)
    moved = {}
    for name in ("fold_dir", "binance_dir", "funding_dir"):
        shutil.copytree(getattr(panel, name), dest / name)
        moved[name] = dest / name
    return dataclasses.replace(panel, **moved)


def test_confirm_preflight_failures_stop_before_the_marker(planted, tmp_path, relaxed, monkeypatch):
    panel, dev_dir = confirm_setup(planted, tmp_path, monkeypatch)
    out = tmp_path / "pf"
    prepare_confirm(panel, dev_dir, out=out)
    marker = confirm_files(panel, out).marker
    bad = copy_panel(panel, tmp_path / "bad")
    # a fold day whose bytes changed after the manifest was written
    day = bad.fold_dir / "v1" / "date=2025-08-10.parquet"
    good = day.read_bytes()
    day.write_bytes(good + b"x")
    with pytest.raises(DataError, match="2025-08-10"):
        run_confirm(bad, dev_dir, out)
    day.write_bytes(good)
    # a fold day missing from the manifest
    manifest = bad.fold_dir / "manifest.jsonl"
    text = manifest.read_text()
    manifest.write_text("".join(x + "\n" for x in text.splitlines() if "2025-08-11" not in x))
    with pytest.raises(DataError, match="2025-08-11"):
        run_confirm(bad, dev_dir, out)
    manifest.write_text(text)
    # Binance files that do not parse for a month the source guard may read
    for path in (bad.binance_dir).rglob("*-2025-08.csv.gz"):
        with gzip.open(path, "wt") as f:
            f.write("not,a,header\n1,2,3\n")
    with pytest.raises(DataError, match="header|parse|Binance"):
        run_confirm(bad, dev_dir, out)
    assert not marker.exists()
    # the unharmed data still runs
    res = read_json(run_confirm(panel, dev_dir, out))
    assert marker.exists() and res["preflight"]["fold_days_checked"] == 45


def test_pre_flight_checks_funding_unknown_ids_and_the_binance_structure(planted, tmp_path, relaxed, monkeypatch):
    panel, dev_dir = confirm_setup(planted, tmp_path, monkeypatch)
    monkeypatch.setattr(lock, "CONFIRM_LAST_DATE", CONFIRM_LAST)
    reader = DataReader(
        fold_dir=panel.fold_dir,
        binance_dir=panel.binance_dir,
        funding_dir=panel.funding_dir,
        mode="confirm",
        last_date=CONFIRM_LAST,
    )
    span = run.Span(lock.CONFIRM_FIRST_DATE, CONFIRM_LAST)
    prep = run.prepare(reader, span)
    pre = run.confirm_preflight(reader, span, prep)
    assert pre["scale_breaks_found"] == [] and pre["funding_files_checked"] == 6 and pre["binance_files_checked"] > 0
    # a market id in the fold that markets.json does not list
    reader.fold_market_ids.add(77)
    with pytest.raises(DataError, match=r"\[77\]"):
        run.confirm_preflight(reader, span, prep)
    reader.fold_market_ids.discard(77)
    # no funding file for an eligible market
    monkeypatch.setattr(DataReader, "funding_exists", lambda self, mid: mid != 3)
    with pytest.raises(DataError, match=r"funding file for market ids \[3\]"):
        run.confirm_preflight(reader, span, prep)


def test_binance_structure_checks_header_order_duplicates_and_month(tmp_path):
    reader = DataReader(fold_dir=tmp_path, binance_dir=tmp_path, mode="dev")
    head = ",".join(data.BINANCE_HEADER)
    t0 = day_start_ms(dt.date(2025, 7, 1))

    def write(rows, header=head, symbol="XUSDT"):
        path = tmp_path / symbol
        path.mkdir(exist_ok=True)
        with gzip.open(path / f"{symbol}-1m-2025-07.csv.gz", "wt") as f:
            f.write(header + "\n" + "".join(f"{t},1,1,1,1,1,1,1,1,1\n" for t in rows))

    write([t0, t0 + 60_000, t0 + 120_000])
    reader.check_binance_structure("XUSDT", 2025, 7)
    write([t0, t0 + 120_000, t0 + 60_000])
    with pytest.raises(DataError, match="strictly increasing"):
        reader.check_binance_structure("XUSDT", 2025, 7)
    write([t0, t0 + 60_000, t0 + 60_000])
    with pytest.raises(DataError, match="strictly increasing"):
        reader.check_binance_structure("XUSDT", 2025, 7)
    write([t0 - 60_000, t0])
    with pytest.raises(DataError, match="outside its month"):
        reader.check_binance_structure("XUSDT", 2025, 7)
    write([t0], header="open_time,open,close")
    with pytest.raises(DataError, match="header"):
        reader.check_binance_structure("XUSDT", 2025, 7)
    with pytest.raises(DataError, match="missing"):
        reader.check_binance_structure("YUSDT", 2025, 7)


def test_a_fold_day_is_checked_against_its_manifest_hash(tmp_path):
    panel = make_panel(tmp_path / "p", PanelSpec(n_markets=3, days=4, seed=2))
    reader = DataReader(fold_dir=panel.fold_dir, mode="dev", last_date=panel.last_date)
    day = dt.date(2025, 7, 2)
    assert reader.fold_day_present(day)
    path = panel.fold_dir / "v1" / "date=2025-07-02.parquet"
    path.write_bytes(path.read_bytes() + b"\0")
    with pytest.raises(DataError, match="sha256 differs"):
        DataReader(fold_dir=panel.fold_dir, mode="dev", last_date=panel.last_date).fold_day_present(day)
    manifest = panel.fold_dir / "manifest.jsonl"
    manifest.write_text(
        "".join(json.dumps({"date": json.loads(x)["date"]}) + "\n" for x in manifest.read_text().splitlines())
    )
    with pytest.raises(DataError, match="no output_sha256"):
        DataReader(fold_dir=panel.fold_dir, mode="dev", last_date=panel.last_date).fold_day_present(day)


def test_a_data_error_after_the_marker_is_recorded_and_allows_one_rerun(planted, tmp_path, relaxed, monkeypatch):
    panel, dev_dir = confirm_setup(planted, tmp_path, monkeypatch)
    out = tmp_path / "again"
    prepare_confirm(panel, dev_dir, out=out)
    paths = confirm_files(panel, out)
    real = run.confirm_statistics

    def boom(*a, **k):
        raise DataError("boom in the data")

    monkeypatch.setattr(run, "confirm_statistics", boom)
    with pytest.raises(DataError, match="boom"):
        run_confirm(panel, dev_dir, out)
    first = read_json(paths.marker)
    assert first["status"] == "error" and "boom in the data" in first["error"] and first["attempt"] == 1
    assert not (out / "confirm_result.json").exists()
    with pytest.raises(SystemExit, match="needs the committed note"):
        run_confirm(panel, dev_dir, out)
    run.write_result(paths.note, {"marker_sha256": first["content_sha256"], "error": "another error"})
    with pytest.raises(SystemExit, match="does not name the error"):
        run_confirm(panel, dev_dir, out)
    run.write_result(paths.note, {"marker_sha256": "0" * 64, "error": first["error"]})
    with pytest.raises(SystemExit, match="does not name the consumed marker"):
        run_confirm(panel, dev_dir, out)
    run.write_result(paths.note, {"marker_sha256": first["content_sha256"], "error": first["error"]})
    monkeypatch.setattr(run, "confirm_statistics", real)
    res = read_json(run_confirm(panel, dev_dir, out))
    note_sha = hashlib.sha256(paths.note.read_bytes()).hexdigest()
    second = read_json(paths.marker)
    assert res["attempt"] == 2 and res["rerun_note_sha256"] == note_sha
    assert second["status"] == "started" and second["attempt"] == 2 and second["rerun_note_sha256"] == note_sha
    assert second["previous_marker_sha256"] == first["content_sha256"]
    assert res["consumed_marker_sha256"] == second["content_sha256"]
    with pytest.raises(SystemExit, match="confirm runs once"):
        run_confirm(panel, dev_dir, out)


def test_a_second_data_error_leaves_the_confirmation_consumed(planted, tmp_path, relaxed, monkeypatch):
    panel, dev_dir = confirm_setup(planted, tmp_path, monkeypatch)
    out = tmp_path / "twice"
    prepare_confirm(panel, dev_dir, out=out)
    paths = confirm_files(panel, out)

    def boom(*a, **k):
        raise DataError("boom in the data")

    monkeypatch.setattr(run, "confirm_statistics", boom)

    def fail_and_name():
        with pytest.raises(DataError, match="boom"):
            run_confirm(panel, dev_dir, out)
        marker = read_json(paths.marker)
        assert marker["status"] == "error"
        run.write_result(paths.note, {"marker_sha256": marker["content_sha256"], "error": marker["error"]})
        return marker

    assert fail_and_name()["attempt"] == 1  # the first error, then a note naming it
    assert fail_and_name()["attempt"] == 2  # the one permitted re-run fails too
    with pytest.raises(SystemExit, match="confirm runs once"):
        run_confirm(panel, dev_dir, out)  # even with a note naming the second error


def test_the_rerun_note_must_be_committed_on_real_data(tmp_path, monkeypatch):
    note = tmp_path / "note.json"
    marker = {"content_sha256": "ab" * 32, "error": "DataError: x"}
    run.write_result(note, {"marker_sha256": marker["content_sha256"], "error": marker["error"]})
    paths = run.ConfirmPaths(tmp_path / "r", tmp_path / "m", note)
    monkeypatch.setattr(run, "_git", lambda a: " M note\n" if a[0] == "status" else "")
    with pytest.raises(SystemExit, match="not committed"):
        run.check_rerun_note(paths, marker, {"synthetic": False})
    assert run.check_rerun_note(paths, marker, {"synthetic": True}) == hashlib.sha256(note.read_bytes()).hexdigest()
    monkeypatch.setattr(run, "_git", lambda a: "")
    assert run.check_rerun_note(paths, marker, {"synthetic": False})


def test_confirm_excludes_a_market_from_a_holding_scale_break_and_exits_open_trades_flagged(
    planted, tmp_path, relaxed, monkeypatch
):
    panel, dev_dir = confirm_setup(planted, tmp_path, monkeypatch)
    out = tmp_path / "ex"
    prepare_confirm(panel, dev_dir, out=out)
    bad = copy_panel(panel, tmp_path / "bad")
    rescale_market(bad, 2, 10, 14, month="2025-08")  # ETH is 10 times higher from 2025-08-10 on
    res = read_json(run_confirm(bad, dev_dir, out))
    [found] = res["preflight"]["scale_breaks_found"]
    assert found["market_id"] == 2 and found["decades"] == 1
    brk = found["minute"]
    assert day_start_ms(dt.date(2025, 8, 10)) <= brk < day_start_ms(dt.date(2025, 8, 11))
    assert res["markets"]["2"]["excluded_scale_breaks"][0]["minute"] == brk
    assert "excluded_scale_breaks" not in res["markets"]["1"]
    assert res["scale_policy"] == "exclude"
    n_forced = 0
    for cid_dir in (out / "confirm_trades").iterdir():
        files = list(cid_dir.glob("market_2.parquet"))
        if not files:
            continue
        t = pq.read_table(files[0]).to_pydict()
        assert max(t["decision_ms"]) < brk  # no decision from the break minute on
        assert all(x <= brk for x in t["exit_ts"])
        for ex, fl in zip(t["exit_ts"], t["flagged"], strict=True):
            if ex == brk:
                assert fl  # the forced exit is flagged
                n_forced += 1
    assert n_forced > 0
    assert read_json(paths_of(bad, out).marker)["status"] == "started"


def paths_of(panel, out):
    return confirm_files(panel, out)


def test_confirm_prints_the_marker_and_the_result_with_their_hashes(planted, tmp_path, relaxed, monkeypatch, capsys):
    panel, dev_dir = confirm_setup(planted, tmp_path, monkeypatch)
    out = tmp_path / "pr"
    prepare_confirm(panel, dev_dir, out=out)
    capsys.readouterr()
    result = run_confirm(panel, dev_dir, out)
    printed = capsys.readouterr().out
    marker = confirm_files(panel, out).marker
    assert "commit these two files together" in printed
    assert f"{marker}  sha256 {hashlib.sha256(marker.read_bytes()).hexdigest()}" in printed
    assert f"{result}  sha256 {hashlib.sha256(result.read_bytes()).hexdigest()}" in printed


def test_a_present_audit_file_must_be_committed_on_real_data(tmp_path, monkeypatch):
    records = tmp_path / "records"
    monkeypatch.setattr(run, "RECORDS_DIR", records)
    assert run.load_suspect_cleared(False) == ((), None)  # absent means empty
    write_audit(records, ["cfg-a"])
    monkeypatch.setattr(run, "_git", lambda a: " M x\n" if a[0] == "status" else "")
    with pytest.raises(SystemExit, match="not committed"):
        run.load_suspect_cleared(False)
    assert run.load_suspect_cleared(True)[0] == ("cfg-a",)  # a synthetic rehearsal needs no commit
    monkeypatch.setattr(run, "_git", lambda a: "")
    ids, sha = run.load_suspect_cleared(False)
    assert ids == ("cfg-a",) and sha == hashlib.sha256((records / run.SUSPECT_FILE).read_bytes()).hexdigest()


def test_confirm_with_no_finalists_writes_an_empty_result(planted, tmp_path, monkeypatch):
    panel, dev_out, _ = planted
    monkeypatch.setattr(lock, "CONFIRM_FIRST_DATE", dt.date(2025, 8, 1))
    monkeypatch.setattr(run, "RECORDS_DIR", tmp_path / "records")
    dev_dir = copy_dev(dev_out, tmp_path / "dev")
    write_nulls(dev_dir, prov_of(panel), [50.0] * 20, [50.0] * 20)
    run.cmd_report(args_for(panel, dev_dir), last_date=JULY_END)
    assert read_json(dev_dir / "finalists.json")["finalists"] == []
    prepare_confirm(panel, dev_dir, out=tmp_path / "out")
    res = read_json(run_confirm(panel, dev_dir, tmp_path / "out"))
    assert res["results"] == []


def test_confirm_needs_the_dev_dir(planted, tmp_path):
    panel, dev_out, _ = planted
    fin = tmp_path / "f.json"
    run.write_result(fin, {**prov_of(panel), "finalists": []})
    with pytest.raises(SystemExit, match="dev-dir"):
        run.cmd_confirm(
            args_for(panel, tmp_path / "o", finalists=str(fin), dev_dir=None, prepare=True, run=False),
            last_date=dt.date(2025, 8, 14),
        )


def test_null_runs_without_a_maximum_are_an_error():
    shift = [{"max_t": 1.0}] * 19 + [{"max_t": None}]
    with pytest.raises(SystemExit, match="no maximum"):
        run.bars_from_nulls(shift, [{"max_t": 1.0}] * 20)
    with pytest.raises(SystemExit, match="no maximum"):
        run.bars_from_nulls([{"max_t": 1.0}] * 20, [{"max_t": None}] + [{"max_t": 1.0}] * 19)
    assert run.bars_from_nulls([{"max_t": 1.0}, {"max_t": 3.0}], [{"max_t": 2.0}])[:2] == (3.0, 2.0)


# ----------------------------------------------------------------------------------------------------------------
# Point-in-time universe: eligibility gates the opening of trades only


@pytest.fixture(scope="module")
def two_months(tmp_path_factory):
    """Two months of 3 markets with a hand-set eligibility: market 1 July only, market 2 both, market 3 (tier B) Aug."""
    root = tmp_path_factory.mktemp("two")
    panel = make_panel(root, PanelSpec(n_markets=3, days=45, seed=9, pre_days=2))
    reader = DataReader(
        fold_dir=panel.fold_dir,
        binance_dir=panel.binance_dir,
        funding_dir=panel.funding_dir,
        mode="dev",
        last_date=panel.last_date,
    )

    def info(tier):
        return run.MonthInfo(tier, 6000.0, 0.8, 3000, None, "lighter")

    elig = {(2025, 7): {1: info("A"), 2: info("A")}, (2025, 8): {2: info("A"), 3: info("B")}}
    proxies = {(2025, 7): {1: 0.8, 2: 0.8}, (2025, 8): {2: 0.8, 3: 2.0}}
    return panel, reader, reader.load_markets(), elig, proxies, run.Span(lock.DEV_FIRST_DATE, panel.last_date)


def trades_of(directory: Path, cid: str, market_id: int):
    files = list((directory / cid).glob(f"market_{market_id}.parquet"))
    return pq.read_table(files[0]).to_pydict() if files else None


def month_of_ms(ms: int) -> int:
    return dt.datetime.fromtimestamp(ms / 1000, dt.UTC).month


AUG1 = day_start_ms(dt.date(2025, 8, 1))


def grid(two, cfgs, **kw):
    _, reader, markets, elig, proxies, span = two
    return run.run_grid(reader, markets, elig, proxies, cfgs, span, **kw)


def test_a_market_that_stops_being_eligible_keeps_its_open_trade_and_opens_no_new_one(two_months, tmp_path):
    ab = "F1-k1-th1.0-h240-time-AB"
    results, _ = grid(two_months, [lock.CONFIG_BY_ID[ab], lock.CONFIG_BY_ID[ab[:-1]]], trades_dir=tmp_path)
    m1 = trades_of(tmp_path, ab, 1)
    assert {month_of_ms(d) for d in m1["decision_ms"]} == {7}
    assert any(e >= AUG1 for e in m1["exit_ts"]) and max(m1["exit_ts"]) - AUG1 < 5 * 3_600_000
    assert {month_of_ms(d) for d in trades_of(tmp_path, ab, 2)["decision_ms"]} == {7, 8}
    order = np.argsort(m1["decision_ms"])
    assert all(m1["decision_ms"][order[i + 1]] >= m1["exit_ts"][order[i]] for i in range(len(order) - 1))
    assert results[0]["trades"] > results[1]["trades"]


def test_universe_a_trades_tier_a_months_only(two_months, tmp_path):
    cfgs = [lock.CONFIG_BY_ID[c] for c in ("F1-k1-th1.0-h60-time-AB", "F1-k1-th1.0-h60-time-A")]
    grid(two_months, cfgs, trades_dir=tmp_path)
    m3 = trades_of(tmp_path, "F1-k1-th1.0-h60-time-AB", 3)
    assert m3 is not None and {month_of_ms(d) for d in m3["decision_ms"]} == {8}
    assert trades_of(tmp_path, "F1-k1-th1.0-h60-time-A", 3) is None


def test_the_noise_shift_applies_eligibility_after_shifting(two_months, tmp_path):
    cid = "F1-k1-th1.0-h60-time-AB"
    cfg = [lock.CONFIG_BY_ID[cid]]
    grid(two_months, cfg, trades_dir=tmp_path / "plain")
    grid(two_months, cfg, shift_days=10, trades_dir=tmp_path / "shifted")
    for mid, allowed in ((1, {7}), (3, {8}), (2, {7, 8})):
        plain, shifted = trades_of(tmp_path / "plain", cid, mid), trades_of(tmp_path / "shifted", cid, mid)
        assert {month_of_ms(d) for d in shifted["decision_ms"]} <= allowed
        assert set(shifted["decision_ms"]) != set(plain["decision_ms"])


def test_a_market_without_a_funding_file_that_trades_is_an_error(two_months, tmp_path):
    panel, _, markets, elig, proxies, span = two_months
    reader = DataReader(
        fold_dir=panel.fold_dir,
        binance_dir=panel.binance_dir,
        funding_dir=tmp_path,
        mode="dev",
        last_date=panel.last_date,
    )
    with pytest.raises(DataError, match="funding"):
        run.run_grid(reader, markets, elig, proxies, [lock.CONFIG_BY_ID["F1-k1-th1.0-h60-time-AB"]], span)


def test_a_missing_fold_day_inside_the_span_stops_dev(tmp_path):
    panel = make_panel(tmp_path / "p", PanelSpec(n_markets=3, days=6, seed=3))
    manifest = panel.fold_dir / "manifest.jsonl"
    manifest.write_text("\n".join(x for x in manifest.read_text().splitlines() if "2025-07-03" not in x) + "\n")
    with pytest.raises(DataError, match="2025-07-03"):
        run.cmd_dev(args_for(panel, tmp_path / "o"), last_date=panel.last_date, configs=[lock.GRID[0]])


# ----------------------------------------------------------------------------------------------------------------
# Git attestation and the command line


def test_provenance_uses_the_environment_when_git_is_unavailable(tmp_path, monkeypatch):
    def no_git(args):
        raise OSError("no git")

    monkeypatch.setattr(run, "_git", no_git)
    monkeypatch.delenv("LIGHTER_GIT_HEAD", raising=False)
    monkeypatch.delenv("LIGHTER_TREE_CLEAN", raising=False)
    with pytest.raises(SystemExit, match="LIGHTER_GIT_HEAD"):
        run.provenance(tmp_path)
    monkeypatch.setenv("LIGHTER_GIT_HEAD", "deadbeef")
    with pytest.raises(SystemExit):
        run.provenance(tmp_path)  # a head without the clean attestation is not enough
    monkeypatch.setenv("LIGHTER_TREE_CLEAN", "1")
    prov = run.provenance(tmp_path)
    assert prov["git_head"] == "deadbeef" and prov["git_source"] == "attested by environment"
    # when git IS available the environment is ignored and the tree is checked directly
    monkeypatch.setattr(run, "_git", lambda a: "abc\n" if a[0] == "rev-parse" else " M lighter/x.py\n")
    with pytest.raises(SystemExit, match="uncommitted"):
        run.provenance(tmp_path)
    monkeypatch.setattr(run, "_git", lambda a: "abc\n" if a[0] == "rev-parse" else "")
    prov = run.provenance(tmp_path)
    assert prov["git_head"] == "abc" and prov["git_source"] == "git"


def test_cli_eligibility_dev_null_and_the_refusals(tmp_path, monkeypatch):
    panel = make_panel(tmp_path / "p", PanelSpec(n_markets=4, days=10, seed=8))
    monkeypatch.setattr(lock, "DEV_LAST_DATE", panel.last_date)
    out = tmp_path / "out"
    base = ["--fold-dir", str(panel.fold_dir), "--binance-dir", str(panel.binance_dir), "--out-dir", str(out)]
    common = [*base, "--funding-dir", str(panel.funding_dir)]
    assert run.main(["eligibility", *base]) == 0
    elig = read_json(out / "eligibility.json")
    assert elig["months"]["2025-07"]["eligible"] and elig["synthetic"] is True
    assert run.main(["dev", *common]) == 0
    dev = read_json(out / "dev_result.json")
    assert dev["eligibility"]["months"] == elig["months"] and dev["eligibility_sha256"] == elig["eligibility_sha256"]
    assert run.main(["null", *common, "--seed", "2"]) == 0
    assert (out / "null_shift_2.json").exists() and (out / "null_f6_2.json").exists()
    with pytest.raises(SystemExit):
        run.main(["report", *common])
    with pytest.raises(SystemExit):
        run.main(["confirm", *common])
    with pytest.raises(SystemExit):
        run.main(["null", *common])


def test_the_development_span_is_the_locked_one():
    assert day_start_ms(lock.DEV_LAST_DATE) + lock.DAY_MS == day_start_ms(dt.date(2026, 7, 1))
    assert lock.DEV_FIRST_DATE == dt.date(2025, 7, 1)
    reader = DataReader(fold_dir=".", mode="dev")
    assert reader.end_ms == day_start_ms(dt.date(2026, 7, 1))


# ----------------------------------------------------------------------------------------------------------------
# The registration anchor


@pytest.fixture
def real_looking(tmp_path, monkeypatch):
    """Data directories that are NOT synthetic, a clean mocked git and an empty records directory."""
    monkeypatch.setattr(run, "_git", lambda a: "abc\n" if a[0] == "rev-parse" else "")
    monkeypatch.setattr(run, "RECORDS_DIR", tmp_path / "records")
    fold, binance, funding = tmp_path / "fold", tmp_path / "binance", tmp_path / "funding"
    (fold / "v1").mkdir(parents=True)
    (fold / "manifest.jsonl").write_text(
        json.dumps({"date": "2025-06-01", "source_url": "https://aws.example/x"}) + "\n"
    )
    (fold / "markets.json").write_text(
        json.dumps({"markets_file_version": 2, "source": "https://x", "order_books": []})
    )
    (funding / "funding").mkdir(parents=True)
    (funding / "funding" / "manifest.jsonl").write_text('{"market_id": 1, "status": "ok"}\n')
    (binance / "BTCUSDT").mkdir(parents=True)
    (binance / "BTCUSDT" / "BTCUSDT-1m-2025-07.csv.gz").write_bytes(b"abc")
    return argparse.Namespace(fold_dir=fold, binance_dir=binance, funding_dir=funding, out_dir=tmp_path / "out")


def test_register_check_prints_the_anchor_and_commands_refuse_on_any_difference(real_looking, capsys, monkeypatch):
    args = real_looking
    (args.funding_dir / "funding" / "market_1.parquet").write_bytes(b"funding-bytes")
    got = run.anchor_contents(args.fold_dir, args.binance_dir, args.funding_dir)
    assert got["lock_sha256"] == lock.lock_digest()
    assert got["binance_files"] == [["BTCUSDT/BTCUSDT-1m-2025-07.csv.gz", 3]]
    assert all(
        got[k]
        for k in (
            "fold_manifest_sha256",
            "markets_json_sha256",
            "funding_manifest_sha256",
            "funding_files_sha256",
            "binance_files_sha256",
        )
    )
    assert (
        run.main(
            [
                "register-check",
                "--fold-dir",
                str(args.fold_dir),
                "--binance-dir",
                str(args.binance_dir),
                "--funding-dir",
                str(args.funding_dir),
            ]
        )
        == 0
    )
    assert json.loads(capsys.readouterr().out) == got
    prov = run.provenance(args.fold_dir)
    assert prov["synthetic"] is False
    with pytest.raises(SystemExit, match="registration anchor"):
        run.check_registration(args, prov)  # the file is absent
    anchor = run.RECORDS_DIR / run.REGISTRATION_FILE
    anchor.parent.mkdir(parents=True)
    anchor.write_text(json.dumps(got))
    run.check_registration(args, prov)  # matches
    committed = run._git
    monkeypatch.setattr(run, "_git", lambda a: " M anchor\n" if a[0] == "status" and "records" in a[-1] else "")
    with pytest.raises(SystemExit, match="not committed"):
        run.check_registration(args, prov)  # the anchor is edited since HEAD
    monkeypatch.setattr(run, "_git", committed)
    (args.fold_dir / "manifest.jsonl").write_text("{}\n")
    with pytest.raises(SystemExit, match="fold_manifest_sha256"):
        run.check_registration(args, prov)
    anchor.write_text(
        json.dumps(
            {
                **got,
                "fold_manifest_sha256": run.anchor_contents(args.fold_dir, args.binance_dir, args.funding_dir)[
                    "fold_manifest_sha256"
                ],
            }
        )
    )
    run.check_registration(args, prov)
    (args.binance_dir / "BTCUSDT" / "BTCUSDT-1m-2025-07.csv.gz").write_bytes(b"abcd")  # one byte longer
    with pytest.raises(SystemExit, match="binance_files"):
        run.check_registration(args, prov)
    (args.binance_dir / "BTCUSDT" / "BTCUSDT-1m-2025-07.csv.gz").write_bytes(b"abd")  # same size, other bytes
    with pytest.raises(SystemExit, match="binance_files_sha256") as exc:
        run.check_registration(args, prov)
    assert "binance_files'" not in str(exc.value)
    (args.binance_dir / "BTCUSDT" / "BTCUSDT-1m-2025-07.csv.gz").write_bytes(b"abc")
    (args.funding_dir / "funding" / "market_1.parquet").write_bytes(b"funding-byteX")
    with pytest.raises(SystemExit, match="funding_files_sha256"):
        run.check_registration(args, prov)
    (args.funding_dir / "funding" / "market_1.parquet").write_bytes(b"funding-bytes")
    run.check_registration(args, prov)
    (args.fold_dir / "markets.json").write_text("{}")
    with pytest.raises(SystemExit, match="markets_json_sha256"):
        run.check_registration(args, prov)
    anchor.write_text(json.dumps({**got, "lock_sha256": "0" * 64}))
    with pytest.raises(SystemExit, match="lock_sha256"):
        run.check_registration(args, prov)
    run.check_registration(args, {**prov, "synthetic": True})  # synthetic data needs no anchor


def test_dev_null_report_and_confirm_refuse_without_the_anchor_and_eligibility_does_not_need_it(
    real_looking, monkeypatch
):
    args = real_looking
    monkeypatch.setattr(lock, "FUNDING_STAMP_VERIFIED", True)
    for cmd, extra in (
        (run.cmd_dev, {}),
        (run.cmd_null, {"seed": 1}),
        (run.cmd_report, {}),
        (run.cmd_confirm, {"finalists": None, "dev_dir": None, "prepare": True, "run": False}),
    ):
        with pytest.raises(SystemExit, match="registration anchor"):
            cmd(argparse.Namespace(**vars(args), **extra))
    # eligibility and scalescan run before registration: they fail on missing data, not on the anchor
    with pytest.raises((DataError, FileNotFoundError, ValueError, KeyError)):
        run.cmd_eligibility(argparse.Namespace(**vars(args), through="dev", finalists=None))


# ----------------------------------------------------------------------------------------------------------------
# The scale scan


def rehash_manifest(fold_dir: Path):
    """Rewrite output_sha256 of every manifest line after a test edited the fold files."""
    lines = [json.loads(x) for x in (fold_dir / "manifest.jsonl").read_text().splitlines()]
    for rec in lines:
        path = fold_dir / "v1" / f"date={rec['date']}.parquet"
        rec["output_sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
    (fold_dir / "manifest.jsonl").write_text("".join(json.dumps(r) + "\n" for r in lines))


def rescale_market(panel, market_id: int, first_day: int, last_day: int, factor: int = 10, month: str = "2025-07"):
    """From <month>-<first_day> on every price of one market is `factor` times higher (a unit change)."""
    for day in range(first_day, last_day + 1):
        path = panel.fold_dir / "v1" / f"date={month}-{day:02d}.parquet"
        table = pq.read_table(path)
        for name in ("last_px", "last_buy_px", "last_sell_px", "first_buy_px", "first_sell_px"):
            col = table.column(name).to_numpy(zero_copy_only=False)
            mask = table.column("market_id").to_numpy() == market_id
            null = np.isnan(col)
            vals = np.where(null, 0, np.where(mask, col * factor, col)).astype(np.int64)
            table = table.set_column(
                table.schema.get_field_index(name), name, pa.array(vals, mask=null, type=pa.int64())
            )
        pq.write_table(table, path)
    rehash_manifest(panel.fold_dir)


def scale_binance(panel, symbol: str, factor: float):
    """Multiply open, high, low and close of every month file of one symbol (the later unit of a rescaled market)."""
    for path in sorted((panel.binance_dir / symbol).glob(f"{symbol}-1m-*.csv.gz")):
        with gzip.open(path, "rt") as f:
            lines = f.read().splitlines()
        out = [lines[0]]
        for line in lines[1:]:
            r = line.split(",")
            px = ",".join(f"{float(x) * factor:.6f}" for x in r[1:5])
            out.append(",".join([r[0], px, *r[5:]]))
        with gzip.open(path, "wt") as f:
            f.write("\n".join(out) + "\n")


def test_scalescan_lists_a_planted_rescaling_and_dev_stops_on_it(tmp_path, monkeypatch):
    panel = make_panel(tmp_path / "p", PanelSpec(n_markets=3, days=6, seed=2))
    rescale_market(panel, 2, 4, 6)
    seen: list[tuple[str, ...]] = []
    real = pq.read_table

    def spy(path, *a, **k):
        seen.append(tuple(k.get("columns") or ()))
        return real(path, *a, **k)

    monkeypatch.setattr(data.pq, "read_table", spy)
    path = run.cmd_scalescan(args_for(panel, tmp_path / "o"), last_date=panel.last_date)
    monkeypatch.setattr(data.pq, "read_table", real)
    doc = read_json(path)
    assert set().union(*seen) <= {"market_id", "minute", "last_px", "last_buy_px", "last_sell_px"}  # mid inputs only
    assert doc["markets_scanned"] == 3 and "no strategy return" in doc["computes"]
    holding = [c for c in doc["candidates"] if c["holds"]]
    assert [(c["market_id"], c["decades"]) for c in holding] == [(2, 1)]
    assert day_start_ms(dt.date(2025, 7, 4)) <= holding[0]["minute"] < day_start_ms(dt.date(2025, 7, 4)) + 3_600_000
    assert doc["holding"] == holding
    with pytest.raises(DataError, match=r"price-scale break in ETH \(market_id 2\)"):
        run.cmd_dev(args_for(panel, tmp_path / "dev"), last_date=panel.last_date, configs=[lock.GRID[0]])


def test_a_listed_scale_break_gives_the_same_trades_as_the_panel_without_it(tmp_path, monkeypatch):
    spec = PanelSpec(n_markets=3, days=6, seed=2)
    plain = make_panel(tmp_path / "plain", spec)
    rescaled = make_panel(tmp_path / "rescaled", spec)
    rescale_market(rescaled, 2, 4, 6)
    scale_binance(rescaled, "ETHUSDT", 10)  # the later unit, so the source guard sees one scale after listing
    cfgs = f1_configs(holds=(15, 60), thetas=(1.0,), ks=(1, 3))
    base = read_json(run.cmd_dev(args_for(plain, tmp_path / "o1"), last_date=plain.last_date, configs=cfgs))
    with pytest.raises(DataError, match="price-scale break"):
        run.cmd_dev(args_for(rescaled, tmp_path / "o2"), last_date=rescaled.last_date, configs=cfgs)
    found = [
        c
        for c in read_json(run.cmd_scalescan(args_for(rescaled, tmp_path / "s"), last_date=rescaled.last_date))[
            "holding"
        ]
    ]
    assert len(found) == 1
    # listed: the raw prices before the minute are multiplied by 10^k, so the series is continuous at the later scale
    monkeypatch.setattr(lock, "KNOWN_SCALE_BREAKS", ((found[0]["market_id"], found[0]["minute"], found[0]["decades"]),))
    listed = read_json(run.cmd_dev(args_for(rescaled, tmp_path / "o3"), last_date=rescaled.last_date, configs=cfgs))
    a, b = by_id(base), by_id(listed)
    assert a.keys() == b.keys() and any(c["trades"] > 0 for c in a.values())
    for cid in a:
        assert a[cid]["trades"] == b[cid]["trades"]
        assert b[cid]["t"] == pytest.approx(a[cid]["t"], abs=1e-9)
        assert b[cid]["mean_net_bps"] == pytest.approx(a[cid]["mean_net_bps"], abs=1e-9)
    # the run no longer stops, and the scan of the listed panel finds nothing left to list
    after = read_json(run.cmd_scalescan(args_for(rescaled, tmp_path / "s2"), last_date=rescaled.last_date))
    assert after["holding"] == []


def test_a_known_scale_break_with_k_zero_is_refused(tmp_path, monkeypatch):
    panel = make_panel(tmp_path / "p", PanelSpec(n_markets=3, days=4, seed=2))
    monkeypatch.setattr(lock, "KNOWN_SCALE_BREAKS", ((2, day_start_ms(dt.date(2025, 7, 3)), 0),))
    with pytest.raises(DataError, match="k = 0"):
        run.cmd_dev(args_for(panel, tmp_path / "o"), last_date=panel.last_date, configs=[lock.GRID[0]])


def test_scalescan_and_the_run_cover_the_same_window(tmp_path, monkeypatch):
    panel = make_panel(tmp_path / "p", PanelSpec(n_markets=3, days=4, seed=2))
    windows: list[tuple[int, int]] = []
    real = DataReader.load_minutes

    def spy(self, market, t0_ms, end_ms, *a, **k):
        if k.get("mid_only"):
            windows.append((t0_ms, end_ms))
        return real(self, market, t0_ms, end_ms, *a, **k)

    monkeypatch.setattr(DataReader, "load_minutes", spy)
    run.cmd_scalescan(args_for(panel, tmp_path / "o"), last_date=panel.last_date)
    span = run.Span(lock.DEV_FIRST_DATE, panel.last_date)
    assert set(windows) == {(span.t0_ms, span.end_ms)}  # warm-up start to the end, as run_grid checks


def test_scalescan_on_a_clean_panel_finds_nothing(tmp_path):
    panel = make_panel(tmp_path / "p", PanelSpec(n_markets=3, days=4, seed=2))
    doc = read_json(run.cmd_scalescan(args_for(panel, tmp_path / "o"), last_date=panel.last_date))
    assert doc["candidates"] == [] and doc["holding"] == [] and doc["kind"] == "scalescan"


# ----------------------------------------------------------------------------------------------------------------
# The source guard on 15 minute returns


def test_the_guard_correlates_non_overlapping_15_minute_returns():
    ok = run.guard_month(_month_md())
    # about one 15 minute return per three 5m grid points of a 30 day month, minus invalid ones
    assert 2000 < ok["return_points"] <= 2880
    assert lock.GUARD_MIN_POINTS == 1000 and lock.GUARD_MIN_CORR == 0.5 and lock.GUARD_MAX_MEDIAN_BPS == 50.0
    assert ok["corr"] > 0.9


# ----------------------------------------------------------------------------------------------------------------
# Bursts: the cost model against the generator's own quotes


@pytest.fixture(scope="module")
def burst_panel(tmp_path_factory):
    root = tmp_path_factory.mktemp("burst")
    panel = make_panel(
        root,
        PanelSpec(
            n_markets=3,
            days=31,
            seed=23,
            micro=True,
            half_spreads_bps=(0.4, 0.4, 0.4),
            micro_burst_frac=0.1,
            micro_burst_factor=10.0,
        ),
    )
    return panel


def test_burst_regression_the_doubled_spread_run_is_not_optimistic_against_the_true_cost(burst_panel, tmp_path):
    panel = burst_panel
    reader, span, prep = _grid_inputs(panel)
    assert len(prep.elig[(2025, 7)]) == 3, "all three markets must be eligible for the test to mean anything"
    cfgs = [lock.CONFIG_BY_ID["F1-k1-th1.0-h15-time-AB"], lock.CONFIG_BY_ID["F1-k3-th1.0-h15-time-AB"]]
    out = {}
    for mult in (1.0, 2.0):
        res, _ = run.run_grid(
            reader,
            prep.markets,
            prep.elig,
            prep.proxies,
            cfgs,
            span,
            spread_mult=mult,
            trades_dir=tmp_path / f"x{mult}",
        )
        out[mult] = res
    lines = []
    for cfg in cfgs:
        true_cost, nets = {}, {}
        for mult in (1.0, 2.0):
            files = sorted((tmp_path / f"x{mult}" / cfg.cid).glob("market_*.parquet"))
            tables = [pq.read_table(f) for f in files]
            net = np.concatenate([t.column("net").to_numpy() for t in tables]) * 1e4
            cost = []
            for t in tables:
                mid = int(t["market_id"][0].as_py())
                half = panel.quote_half_bps[mid]
                e_min = (t.column("entry_ts").to_numpy() - panel.first_day_ms) // 60_000
                x_min = (t.column("exit_ts").to_numpy() - panel.first_day_ms) // 60_000
                cost.append(half[e_min] + half[x_min])  # half a spread at each fill, from the generator's quotes
            nets[mult], true_cost[mult] = net, np.concatenate(cost)
        for mult in (1.0, 2.0):
            net, cost = nets[mult], true_cost[mult]
            se = net.std() / np.sqrt(len(net) / 3)  # overlapping decisions: inflate by sqrt(3)
            bias = net.mean() + cost.mean()  # > 0: the simulation charges less than the true cost
            lines.append(
                f"{cfg.cid} x{mult:.0f}: net {net.mean():.3f} true cost {cost.mean():.3f} bias {bias:+.3f} se {se:.3f}"
            )
            if mult == 2.0:
                assert bias < 3 * se, lines[-1]  # not optimistic against the quotes, within what its error allows
        assert nets[2.0].mean() < nets[1.0].mean()  # doubling can only cost more
    print("\n".join(lines))
    for r in out[1.0]:
        assert 0.0 <= r["tie_share"] <= 1.0 and r["mean_fill_cost_bps"] > 0
