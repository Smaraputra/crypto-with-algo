"""Synthetic D-shaped panel: GARCH daily volatility, Student-t 5m shocks, input daily covariance. Synthetic only."""

from __future__ import annotations

import gzip
import io
import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from r4.data import dataset_hash_of

DAY_MS = 86_400_000
BAR_MS = 300_000
BARS_PER_DAY = 288
FUNDING_MS = 8 * 3_600_000
AGGREGATES: dict[str, int] = {"15m": 3, "1h": 12, "4h": 48, "1d": 288}
START_PRICE = 100.0


def _frame(t: np.ndarray, o: np.ndarray, h: np.ndarray, lo: np.ndarray, c: np.ndarray, v: np.ndarray, tbv: np.ndarray):
    return pd.DataFrame({"t": t, "o": o, "h": h, "l": lo, "c": c, "v": v, "tbv": tbv})


def synth_panel(
    cov_daily: Any,
    symbols: Sequence[str],
    start_ms: int,
    end_ms: int,
    seed: int,
    garch: tuple[float, float] = (0.08, 0.88),
    t_df: float = 4.5,
) -> dict[str, dict[str, pd.DataFrame]]:
    """A panel in the format `load_panel` returns, over [start_ms, end_ms) on whole UTC days.

    Daily variance per coin follows a GARCH(1,1) recursion on the realised daily return with unconditional variance
    diag(cov_daily). 5m log returns are (sigma_d / sqrt(288)) x (L @ eps), L the Cholesky factor of the daily
    correlation matrix and eps iid standardised Student-t(t_df) shocks, so daily sums carry the covariance and the
    volatility clustering. Funding settlements (rate 0) and premium index rows (value 0) cover the whole span.
    """
    cov = np.asarray(cov_daily, dtype=np.float64)
    syms = list(symbols)
    k = len(syms)
    if cov.shape != (k, k) or not np.allclose(cov, cov.T):
        raise ValueError("cov_daily must be a symmetric (n_symbols x n_symbols) matrix")
    if start_ms % DAY_MS or end_ms % DAY_MS or end_ms <= start_ms:
        raise ValueError("start_ms and end_ms must be UTC day boundaries with end_ms > start_ms")
    alpha, beta = garch
    if alpha < 0 or beta < 0 or alpha + beta >= 1.0 or t_df <= 2.0:
        raise ValueError("need garch alpha, beta >= 0 with alpha + beta < 1, and t_df > 2")

    n_days = (end_ms - start_ms) // DAY_MS
    n = n_days * BARS_PER_DAY
    var = np.diag(cov).copy()
    sd = np.sqrt(var)
    chol = np.linalg.cholesky(cov / np.outer(sd, sd))
    rng = np.random.default_rng(seed)

    eps = rng.standard_t(t_df, size=(n_days, BARS_PER_DAY, k)) / np.sqrt(t_df / (t_df - 2.0))
    shocks = eps @ chol.T

    omega = var * (1.0 - alpha - beta)
    sig2 = var.copy()
    sigma_d = np.empty((n_days, k))
    x = np.empty((n_days, BARS_PER_DAY, k))
    for d in range(n_days):
        sigma_d[d] = np.sqrt(sig2)
        x[d] = shocks[d] * (sigma_d[d] / np.sqrt(BARS_PER_DAY))
        r = x[d].sum(axis=0)
        sig2 = omega + alpha * r * r + beta * sig2
    del eps, shocks
    x = x.reshape(n, k)
    sigma_5m = np.repeat(sigma_d, BARS_PER_DAY, axis=0) / np.sqrt(BARS_PER_DAY)

    c = START_PRICE * np.exp(np.cumsum(x, axis=0))
    o = np.vstack([np.full((1, k), START_PRICE), c[:-1]])
    h = np.maximum(o, c) * np.exp(rng.random((n, k)) * 0.5 * sigma_5m)
    lo = np.minimum(o, c) * np.exp(-rng.random((n, k)) * 0.5 * sigma_5m)
    v = np.exp(rng.normal(4.0, 0.5, size=(n, k)))
    tbv = rng.beta(50.0, 50.0, size=(n, k)) * v

    t5 = start_ms + np.arange(n, dtype=np.int64) * BAR_MS
    t_settle = start_ms + np.arange(n_days * 3, dtype=np.int64) * FUNDING_MS
    panel: dict[str, dict[str, pd.DataFrame]] = {}
    for j, sym in enumerate(syms):
        d: dict[str, pd.DataFrame] = {"5m": _frame(t5, o[:, j], h[:, j], lo[:, j], c[:, j], v[:, j], tbv[:, j])}
        for name, m in AGGREGATES.items():
            g = n // m
            d[name] = _frame(
                t5[::m],
                o[:, j].reshape(g, m)[:, 0],
                h[:, j].reshape(g, m).max(axis=1),
                lo[:, j].reshape(g, m).min(axis=1),
                c[:, j].reshape(g, m)[:, -1],
                v[:, j].reshape(g, m).sum(axis=1),
                tbv[:, j].reshape(g, m).sum(axis=1),
            )
        prem = pd.DataFrame({"t": t5, "c": np.zeros(n)})
        fund = pd.DataFrame(
            {"t": t_settle, "rate": np.zeros(len(t_settle)), "intervalHours": np.full(len(t_settle), 8, dtype=np.int64)}
        )
        d["premium_5m"] = prem
        d["premiumIndex"] = prem
        d["settlements"] = fund
        d["funding"] = fund
        panel[sym] = d
    return panel


def _jsonl_gz_bytes(df: pd.DataFrame) -> bytes:
    cols = list(df.columns)
    lines = [json.dumps(dict(zip(cols, row, strict=True))) for row in zip(*(df[c].tolist() for c in cols), strict=True)]
    raw = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=6, mtime=0) as gz:
        gz.write(("\n".join(lines) + "\n").encode("utf-8"))
    return raw.getvalue()


def write_synthetic_dataset(panel: dict[str, dict[str, pd.DataFrame]], out_dir: str | Path) -> Path:
    """Write the dataset layout `r4.data` reads, with a manifest whose datasetHash covers the file hashes.

    The bytes depend only on the panel (gzip mtime 0, no file name), so one seed gives one dataset.
    """
    import hashlib

    root = Path(out_dir)
    entries: list[dict[str, Any]] = []

    def put(rel: str, df: pd.DataFrame) -> None:
        data = _jsonl_gz_bytes(df)
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        entries.append({"path": rel, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})

    for sym, d in panel.items():
        for iv in ("5m", "15m", "1h", "4h", "1d"):
            put(f"perp/{sym}/{iv}.jsonl.gz", d[iv])
        put(f"perp/{sym}/5m.premiumIndex.jsonl.gz", d["premium_5m"])
        put(f"funding/{sym}/settlements.jsonl.gz", d["settlements"])

    entries.sort(key=lambda e: e["path"])
    manifest = {
        "version": 1,
        "datasetHash": dataset_hash_of(entries),
        "symbols": list(panel),
        "files": entries,
    }
    root.mkdir(parents=True, exist_ok=True)
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")
    return root
