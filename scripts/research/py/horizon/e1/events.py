"""Events loader, pair builder, record status, and fetch plan for horizon-e1 (rules 1, 2, 13)."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from horizon.e1 import lock


@dataclass(frozen=True)
class Pair:
    cls: str  # lock.CLASS_T ("T") for tag notices, lock.CLASS_D ("D") for delist notices
    code: str  # article code of the notice
    stamp_ms: int
    day: str  # UTC day of the stamp, YYYY-MM-DD (from the record)
    token: str
    symbol: str | None
    reason: str  # the record's reason for the symbol
    missing_days: tuple[str, ...]
    btc_missing_days: tuple[str, ...]
    pending_notice: str | None  # the record's futures_delist_pending


class RecordError(ValueError):
    """Raised when an event record fails validation."""


def sha256_file(path: Path | str) -> str:
    """Compute sha256 hex digest of a file, streamed in chunks."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
    return h.hexdigest()


def load_record(path: Path | str) -> dict:
    """Parse JSON event record and validate its structure against horizon-e1 lock specification."""
    p = Path(path)
    if not p.is_file():
        raise RecordError(f"record file not found: {p}")
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:
        raise RecordError(f"failed to parse JSON from {p}: {exc}") from exc

    if not isinstance(data, dict):
        raise RecordError("record JSON must be an object")

    top_keys = {"meta", "events", "archive", "btc", "audit", "futures_delist"}
    missing_top = top_keys - set(data.keys())
    if missing_top:
        raise RecordError(f"record missing top-level keys: {sorted(missing_top)}")

    meta = data["meta"]
    if not isinstance(meta, dict):
        raise RecordError("meta must be an object")

    if "freeze_ms" not in meta or meta["freeze_ms"] != lock.FREEZE_MS:
        raise RecordError(f"meta freeze_ms mismatch: expected {lock.FREEZE_MS}, got {meta.get('freeze_ms')}")
    if "from_ms" not in meta or meta["from_ms"] != lock.EVENTS_FROM_MS:
        raise RecordError(f"meta from_ms mismatch: expected {lock.EVENTS_FROM_MS}, got {meta.get('from_ms')}")

    events = data["events"]
    if not isinstance(events, list):
        raise RecordError("events must be a list")

    required_event_keys = {"cls", "code", "ms", "title", "tokens", "source", "day", "perp"}
    seen_codes: set[str] = set()
    prev_key: tuple[int, str] | None = None

    for i, ev in enumerate(events):
        if not isinstance(ev, dict):
            raise RecordError(f"event at index {i} must be an object")

        missing_keys = required_event_keys - set(ev.keys())
        if missing_keys:
            raise RecordError(f"event at index {i} missing required keys: {sorted(missing_keys)}")

        code = ev["code"]
        if not isinstance(code, str) or not code:
            raise RecordError(f"event at index {i} has empty or non-string code: {code}")

        if code in seen_codes:
            raise RecordError(f"duplicate event code: {code}")
        seen_codes.add(code)

        cls_val = ev["cls"]
        if cls_val not in ("tag", "delist"):
            raise RecordError(f"event {code} has unknown cls: {cls_val}")

        tokens = ev["tokens"]
        if not isinstance(tokens, list) or len(tokens) == 0:
            raise RecordError(f"event {code} tokens must be a non-empty list")

        ms = ev["ms"]
        if not isinstance(ms, int) or isinstance(ms, bool):
            raise RecordError(f"event {code} ms must be an integer, got {type(ms)}")
        if ms < lock.EVENTS_FROM_MS or ms >= lock.FREEZE_MS:
            raise RecordError(f"event {code} ms {ms} out of bounds [{lock.EVENTS_FROM_MS}, {lock.FREEZE_MS})")

        expected_day = dt.datetime.fromtimestamp(ms / 1000, tz=dt.UTC).strftime("%Y-%m-%d")
        if ev["day"] != expected_day:
            raise RecordError(f"event {code} day '{ev['day']}' does not match ms UTC day '{expected_day}'")

        perp = ev["perp"]
        if not isinstance(perp, dict):
            raise RecordError(f"event {code} perp must be a dict")
        for tok in tokens:
            if tok not in perp:
                raise RecordError(f"event {code} token '{tok}' missing from perp")

        curr_key = (ms, code)
        if prev_key is not None and curr_key < prev_key:
            raise RecordError(f"events not sorted by (ms, code): {prev_key} followed by {curr_key}")
        prev_key = curr_key

    return data


def build_pairs(record: dict) -> list[Pair]:
    """Map events into trade pairs implementing rule 1."""
    pairs: list[Pair] = []
    seen_tokens: dict[str, set[str]] = {lock.CLASS_T: set(), lock.CLASS_D: set()}

    events = record.get("events", [])
    sorted_events = sorted(events, key=lambda e: (e["ms"], e["code"]))

    for ev in sorted_events:
        ev_cls = lock.CLASS_T if ev["cls"] == "tag" else lock.CLASS_D
        stamp_ms = ev["ms"]
        code = ev["code"]
        day = ev["day"]
        perp = ev.get("perp", {})

        for tok in ev.get("tokens", []):
            if tok in seen_tokens[ev_cls]:
                continue
            seen_tokens[ev_cls].add(tok)

            p_info = perp.get(tok, {})
            reason = p_info.get("reason", "")
            symbol = p_info.get("symbol")
            if reason == "covers-stamp":
                missing_days = tuple(p_info.get("missing_days", []))
                btc_missing_days = tuple(p_info.get("btc_missing_days", []))
                pending_notice = p_info.get("futures_delist_pending")
            else:
                missing_days = ()
                btc_missing_days = ()
                pending_notice = None

            pairs.append(
                Pair(
                    cls=ev_cls,
                    code=code,
                    stamp_ms=stamp_ms,
                    day=day,
                    token=tok,
                    symbol=symbol,
                    reason=reason,
                    missing_days=missing_days,
                    btc_missing_days=btc_missing_days,
                    pending_notice=pending_notice,
                )
            )

    cls_order = {lock.CLASS_T: 0, lock.CLASS_D: 1}
    pairs.sort(key=lambda p: (cls_order.get(p.cls, 99), p.stamp_ms, p.code, p.token))
    return pairs


def record_status(pair: Pair) -> str | None:
    """Record-based checks of rule 2 in order: (s1) -> (s2) -> (s3) -> None."""
    if pair.symbol is None:
        return "no_symbol"
    if pair.pending_notice is not None:
        return "futures_delist_pending"
    if len(pair.missing_days) > 0 or len(pair.btc_missing_days) > 0:
        return "data_missing"
    return None


def first_tag_per_token(pairs: list[Pair]) -> dict[str, int]:
    """Stamp of each token's class T pair."""
    out: dict[str, int] = {}
    for p in pairs:
        if p.cls == lock.CLASS_T and p.token not in out:
            out[p.token] = p.stamp_ms
    return out


def build_fetch_plan(record: dict, pairs: list[Pair]) -> dict:
    """Build download plan for klines and funding files implementing rule 13."""
    klines_set: set[tuple[str, str]] = set()

    btc_info = record.get("btc", {})
    btc_first = btc_info.get("first", "")
    btc_last = btc_info.get("last", "")

    archive = record.get("archive", {})

    for pair in pairs:
        if record_status(pair) is not None:
            continue
        if pair.symbol is None:
            continue

        cands = archive.get(pair.token, {}).get("candidates", [])
        cand = next((c for c in cands if c.get("symbol") == pair.symbol), None)
        cand_first = cand.get("first", "") if cand else ""
        cand_last = cand.get("last", "") if cand else ""

        pair_date = dt.date.fromisoformat(pair.day)
        for offset in (-1, 0, 1, 2):
            target_date = pair_date + dt.timedelta(days=offset)
            if target_date <= lock.HARD_LAST_DATE:
                day_str = target_date.isoformat()
                if cand and cand_first <= day_str <= cand_last:
                    klines_set.add((pair.symbol, day_str))
                if btc_first and btc_first <= day_str <= btc_last:
                    klines_set.add(("BTCUSDT", day_str))

    funding_set: set[tuple[str, str]] = set()
    for symbol, day_str in klines_set:
        month_str = day_str[:7]
        funding_set.add((symbol, month_str))

    klines = [{"day": day, "symbol": sym} for sym, day in sorted(klines_set)]
    funding = [{"month": month, "symbol": sym} for sym, month in sorted(funding_set)]

    return {
        "version": 1,
        "klines": klines,
        "funding": funding,
    }


def plan_bytes(plan: dict) -> bytes:
    """Canonical bytes representation of a fetch plan."""
    return (json.dumps(plan, sort_keys=True, indent=1) + "\n").encode()


def plan_sha256(plan: dict) -> str:
    """Sha256 hex digest of the canonical plan bytes."""
    return hashlib.sha256(plan_bytes(plan)).hexdigest()
