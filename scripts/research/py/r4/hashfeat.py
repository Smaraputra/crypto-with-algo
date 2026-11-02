"""Hash features: seeded standard-normal values keyed by (seed, coin, feature index, decision time).

The noise features `noise_00` to `noise_99` and the planted feature `planted_z` are pure functions of their keys. They
use splitmix64 on a 64-bit mix and the inverse normal CDF, never Python's `hash()`, so a value is the same in every
process. They are never NaN, so a configuration made only of hash features skips the feature frame entirely.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Any

import numpy as np
from scipy.special import ndtri

from r4.method import UNIVERSE

NOISE_DOMAIN = 0x6E6F697365303031  # "noise001"
PLANT_DOMAIN = 0x706C616E74303031  # "plant001"

_NOISE_RE = re.compile(r"noise_(\d{2})")
PLANTED_FEATURE = "planted_z"
_M64 = (1 << 64) - 1
_GOLDEN = np.uint64(0x9E3779B97F4A7C15)
_MUL1 = np.uint64(0xBF58476D1CE4E5B9)
_MUL2 = np.uint64(0x94D049BB133111EB)
_U_MAX = 1.0 - 2.0**-53  # the largest float below 1


def splitmix64(x: np.ndarray) -> np.ndarray:
    """splitmix64 of a uint64 array (wrapping arithmetic)."""
    with np.errstate(over="ignore"):
        z = x.astype(np.uint64, copy=False) + _GOLDEN
        z = (z ^ (z >> np.uint64(30))) * _MUL1
        z = (z ^ (z >> np.uint64(27))) * _MUL2
        return z ^ (z >> np.uint64(31))


def mix64(domain: int, seed: int, *parts: int | np.ndarray) -> np.ndarray:
    """Chain splitmix64 over the domain tag, the seed and each part. Array parts broadcast."""
    h = splitmix64(np.array([(int(domain) ^ int(seed)) & _M64], dtype=np.uint64))
    for part in parts:
        arr = np.asarray(part)
        if arr.dtype.kind in "iu":
            arr = arr.astype(np.uint64)
        else:
            raise TypeError("hash parts must be integers")
        h = splitmix64(h ^ arr)
    return h


def normal_from_hash(h: np.ndarray) -> np.ndarray:
    """Inverse normal CDF of U = (k + 0.5) / 2^53 with k the top 53 bits of h. U is strictly inside (0, 1)."""
    k = (h >> np.uint64(11)).astype(np.float64)
    u = np.minimum((k + 0.5) / 9007199254740992.0, _U_MAX)
    return ndtri(u)


def hash_normal(domain: int, seed: int, sym_idx: int, j: int, t_ms: np.ndarray) -> np.ndarray:
    """Standard normal values for (seed, UNIVERSE index, feature index j, minute t_ms // 60000)."""
    minutes = np.asarray(t_ms, dtype=np.int64) // 60_000
    return normal_from_hash(mix64(domain, seed, sym_idx, j, minutes))


def is_noise_feature(name: str) -> bool:
    return _NOISE_RE.fullmatch(name) is not None


def is_hash_feature(name: str) -> bool:
    return is_noise_feature(name) or name == PLANTED_FEATURE


def noise_index(name: str) -> int:
    m = _NOISE_RE.fullmatch(name)
    if m is None:
        raise ValueError(f"not a noise feature: {name!r}")
    return int(m.group(1))


def universe_index(symbol: str) -> int:
    try:
        return UNIVERSE.index(symbol)
    except ValueError:
        raise ValueError(f"symbol {symbol!r} is not in UNIVERSE") from None


def hash_feature_matrix(
    names: Sequence[str],
    symbol: str,
    symbols: Sequence[str],
    t_ms: np.ndarray,
    noise_seed: int | None,
    plant: dict[str, Any] | None,
) -> np.ndarray:
    """Columns for the hash features `names` of one coin at decision times t_ms. `symbols` is the panel's coin set."""
    t = np.asarray(t_ms, dtype=np.int64)
    out = np.empty((len(t), len(names)), dtype=np.float64)
    idx = universe_index(symbol)
    for c, name in enumerate(names):
        if is_noise_feature(name):
            if noise_seed is None:
                raise ValueError("noise features require noise_seed")
            out[:, c] = hash_normal(NOISE_DOMAIN, noise_seed, idx, noise_index(name), t)
        elif name == PLANTED_FEATURE:
            if plant is None:
                raise ValueError("planted_z requires plant")
            from r4.plant import plant_z

            z = plant_z(int(plant["seed"]), list(symbols), t)
            out[:, c] = z[list(symbols).index(symbol)]
        else:
            raise ValueError(f"not a hash feature: {name!r}")
    return out
