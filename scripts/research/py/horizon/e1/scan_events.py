"""Return-free scan that writes the frozen event record of the horizon-e1 lock (rule 1 of lock.py).

Usage: python3 -I scan_events.py <out.json>   (needs the network through curl; set HORIZON_SCAN_CACHE to reuse pages)

Step 1: crawl Binance's public announcement lists (catalog 49 general news, 161 delistings), title and millisecond
        release time only, and fail when a catalog hits its page cap (a capped crawl would look complete).
Step 2: pick monitoring-tag inclusion notices and spot delisting notices, parse the token tickers. The notice of
        2023-07-26 that introduced the tags names its tokens in the article body, so they are fixed in INTRO_TOKENS and
        checked against the body. Every title that mentions a monitoring tag or a delisting is written to the record
        with a decision and a reason, so a missed notice is visible. Futures delisting titles that name symbols are
        kept as context.
Step 3: list the public data archive for every ticker (and BTCUSDT) under the three symbol forms and record each
        form's first day, last day and missing days. A symbol is chosen per (ticker, notice) as the first form whose
        span covers the stamp. Each futures delisting notice body is read for its USDT symbols and scheduled times, and
        a pair whose symbol was already scheduled to settle at the stamp is flagged.
No price is read. Output: one JSON file with the scan metadata, the events, the archive spans and the audit. Network
access goes through curl only (Python's own TLS fails on the development Mac). Valid answers are cached on disk by URL.
"""

import datetime as dt
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
OUT = sys.argv[1] if len(sys.argv) > 1 else ""
FROM_MS = 1640995200000  # 2022-01-01 00:00 UTC, the start of the delisting window
FREEZE_MS = 1794528000000  # 2026-11-13 00:00 UTC, the freeze of lock horizon-e1 (before the scan began)
BAPI = "https://www.binance.com/bapi/apex/v1/public/apex/cms/article/list/query"
BAPI_DETAIL = "https://www.binance.com/bapi/apex/v1/public/cms/article/detail/query?articleCode="
S3 = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision"
CACHE = os.environ.get("HORIZON_SCAN_CACHE") or os.path.join(tempfile.gettempdir(), "horizon_e1_scan_cache")
PAGE_CAP = {49: 95, 161: 12}
SYMBOL_FORMS = ("", "1000", "1000000")

TAG_PATTERN = re.compile(
    r"Extend the Monitoring Tag (?:to Include|to) (.*?)(?:,? and Remove|, Remove| on \d{4}-\d{2}-\d{2}|$)"
)
DELIST_PATTERN = re.compile(
    r"Binance (?:Announced the \w+ Batch of Vote to Delist Results and )?"
    r"Will Delist ([A-Z0-9, &]+(?: and [A-Z0-9]+)?) on \d{4}-\d{2}-\d{2}$"
)

# The notice of 2023-07-26 03:00 UTC that introduced the Seed Tag and the Monitoring Tag. Its title names no token, so
# the 26 tokens are copied from the article body (checked against the body at every scan). The preprint's sample starts
# with this announcement, so a lock that left it out would drop the one batch that did not fall.
INTRO_CODE = "b0f241491d0e4d75aa2f8752b7bf8af5"
INTRO_TOKENS = (
    "AKRO AMB ARK BTS CREAM DREP ELF FTT GFT JASMY LINA LOOM MLN "
    "MULTI OAX OMG OOKI PERL PNT REN SNM SRM TORN VGX WRX YFII"
).split()

# (ticker, article code) -> archive symbol, or None for "cannot be tied to the notice's token". Fixed by name before any
# price was read. DODO: the contract DODOUSDT ended 2022-05-27 and DODOXUSDT (from 2023-08-08) is not tied to the token
# of the 2026-05-22 notice by any title, so the token is excluded.
OVERRIDES = {("DODO", "ca0f3a3ff83243b79102b4561c8ccdc2"): None}

OTHER_PRODUCT = re.compile(
    r"Margin|Loan|Staking|P2P|Options|Leveraged|Withdrawals of Delisted|Flexible|Earn|Pairs|"
    r"Binance Capital Connect|Fiat Trade"
)
UPDATE_NOTICE = re.compile(r"^Updates? on |Update on the Delisting Date|Postponed|Further Postponed|Support Rebranding")


def log(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)


def curl(url, timeout=40):
    """GET through curl. Valid answers are cached on disk by URL so a dropped run resumes."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, hashlib.sha1(url.encode()).hexdigest() + ".txt")
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    cmd = ["curl", "-s", "-L", "-m", str(timeout), "-A", UA, url]
    text = subprocess.run(cmd, capture_output=True, timeout=timeout + 15).stdout.decode("utf-8", "replace")
    if '"code":"000000"' in text or "ListBucketResult" in text:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
    return text


def crawl(cat):
    """All articles of one catalog. Returns (articles, stats). Fails when the page cap is reached."""
    arts = []
    for page in range(1, PAGE_CAP[cat] + 1):
        d = None
        for attempt in range(5):
            raw = curl(f"{BAPI}?type=1&pageNo={page}&pageSize=50&catalogId={cat}")
            try:
                d = json.loads(raw)
                if d.get("code") == "000000":
                    break
            except ValueError:
                pass
            d = None
            log("retry page", cat, page, "attempt", attempt + 1, flush=True)
            time.sleep(5 * (attempt + 1))
        if d is None:
            raise SystemExit(f"crawl failed at catalog {cat} page {page}, refusing to write a truncated event list")
        cats = (d.get("data") or {}).get("catalogs") or []
        got = (cats[0].get("articles") if cats else []) or []
        arts += got
        if len(got) < 50:
            stamps = [a["releaseDate"] for a in arts if a.get("releaseDate")]
            stats = {
                "pages": page,
                "articles": len(arts),
                "cap": PAGE_CAP[cat],
                "cap_hit": False,
                "oldest_ms": min(stamps),
                "newest_ms": max(stamps),
            }
            return arts, stats
        time.sleep(0.9)
    raise SystemExit(f"catalog {cat} reached its page cap {PAGE_CAP[cat]}: raise PAGE_CAP, the crawl may be incomplete")


def archive_days(sym):
    """Sorted UTC days that have a daily 1m kline file for the USDT-M perpetual `sym` in the public archive."""
    folder = f"data/futures/um/daily/klines/{sym}/1m/"
    base = f"{S3}?delimiter=/&max-keys=1000&prefix={folder}"
    day_pattern = re.compile(re.escape(sym) + r"-1m-(\d{4}-\d{2}-\d{2})\.zip<")
    xml = curl(base, 30)
    days = set(day_pattern.findall(xml))
    while "<IsTruncated>true</IsTruncated>" in xml and days:
        xml = curl(f"{base}&marker={folder}{sym}-1m-{max(days)}.zip", 30)
        more = set(day_pattern.findall(xml))
        if not more - days:
            break
        days |= more
    return sorted(days)


def tickers(seg):
    out = []
    for token in re.split(r",|&| and ", seg):
        token = token.strip()
        if re.fullmatch(r"[A-Z0-9]{1,12}", token):
            out.append(token)
    return out


def decide(title):
    """Return (class, tokens, reason) for a title that mentions a monitoring tag or a delisting."""
    m = TAG_PATTERN.search(title)
    if m and "Monitoring Tag" in title:
        toks = tickers(m.group(1))
        return ("tag", toks, "tag-inclusion") if toks else (None, [], "tag-inclusion-without-tickers")
    m = DELIST_PATTERN.match(title)
    if m:
        toks = tickers(m.group(1))
        return ("delist", toks, "spot-delist") if toks else (None, [], "spot-delist-without-tickers")
    if re.search(r"Futures (?:Will|to) Delist|Futures Will Delist", title):
        return (None, [], "futures-delist")
    if re.search(r"Remove the (?:Monitoring|Seed) Tag", title):
        return (None, [], "tag-removal-only")
    if UPDATE_NOTICE.search(title):
        return (None, [], "update-or-postponement")
    if re.search(r"Vote to Delist on \d{4}-\d{2}-\d{2}$", title):
        return (None, [], "vote-announcement")
    if OTHER_PRODUCT.search(title):
        return (None, [], "other-product")
    return (None, [], "unclassified")


def body_text(detail_json):
    """Plain text of a Binance CMS article body (a JSON tree of nodes)."""
    out = []

    def walk(node):
        if isinstance(node, dict):
            if node.get("node") == "text":
                out.append(node.get("text", ""))
            if node.get("tag") in ("p", "li", "tr", "br"):
                out.append("\n")
            for child in node.get("child", []):
                walk(child)
        elif isinstance(node, list):
            for child in node:
                walk(child)

    walk(json.loads(detail_json["data"]["body"]))
    return "".join(out)


def check_intro_tokens():
    """The tokens named in the body of the introduction notice must equal INTRO_TOKENS."""
    detail = json.loads(curl(BAPI_DETAIL + INTRO_CODE))
    text = body_text(detail)
    start = text.index("applied to the following tokens")
    end = text.index("Binance will conduct periodic project reviews")
    named = re.findall(r"\(([A-Z0-9]{1,12})\)", text[start:end])
    if sorted(named) != sorted(INTRO_TOKENS):
        raise SystemExit(f"introduction notice tokens differ from INTRO_TOKENS: {sorted(named)}")
    return hashlib.sha256(text.encode()).hexdigest()


FUTURES_TIME = re.compile(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2})")
WINDOW_DAYS = (-1, 0, 1, 2)


def utc_ms(text):
    return int(dt.datetime.strptime(text, "%Y-%m-%d %H:%M").replace(tzinfo=dt.UTC).timestamp() * 1000)


def read_futures_notice(entry):
    """Add the USDT symbols and the scheduled times found in the body of a futures delisting notice."""
    text = body_text(json.loads(curl(BAPI_DETAIL + entry["code"])))
    entry["symbols"] = sorted(set(entry["symbols"]) | set(re.findall(r"\b([A-Z0-9]{2,15}USDT)\b", text)))
    times = sorted({utc_ms(t) for t in FUTURES_TIME.findall(text)})
    entry["times_ms"] = times
    entry["latest_ms"] = times[-1] if times else None


def missing_days(days):
    """Calendar days between the first and the last archive day that have no file."""
    have = set(days)
    day, last = dt.date.fromisoformat(days[0]), dt.date.fromisoformat(days[-1])
    out = []
    while day <= last:
        if day.isoformat() not in have:
            out.append(day.isoformat())
        day += dt.timedelta(days=1)
    return out


def span(sym, days):
    return {"symbol": sym, "first": days[0], "last": days[-1], "n_days": len(days), "missing_days": missing_days(days)}


def resolve(tok, code, stamp_ms, day, arch, btc, fdelist):
    """The archive symbol for (token, notice): the first symbol form whose span covers the stamp day."""
    if (tok, code) in OVERRIDES:
        return {"symbol": OVERRIDES[(tok, code)], "reason": "override"}
    cands = arch[tok]["candidates"]
    prev_day = (dt.date.fromisoformat(day) - dt.timedelta(days=1)).isoformat()
    for c in cands:
        if c["first"] <= prev_day and c["last"] >= day:
            need = {(dt.date.fromisoformat(day) + dt.timedelta(days=k)).isoformat() for k in WINDOW_DAYS}
            pending = next(
                (
                    r["code"]
                    for r in fdelist
                    if c["symbol"] in r["symbols"]
                    and r["ms"] < stamp_ms
                    and (r["latest_ms"] is None or r["latest_ms"] >= stamp_ms)
                ),
                None,
            )
            return {
                "symbol": c["symbol"],
                "reason": "covers-stamp",
                "missing_days": sorted(need & set(c["missing_days"])),
                "btc_missing_days": sorted(need & set(btc["missing_days"])),
                "futures_delist_pending": pending,
            }
    if not cands:
        return {"symbol": None, "reason": "no-archive-symbol"}
    if all(c["last"] < day for c in cands):
        return {"symbol": None, "reason": "ended-before-stamp"}
    if all(c["first"] > prev_day for c in cands):
        return {"symbol": None, "reason": "listed-too-late"}
    return {"symbol": None, "reason": "no-form-covers-stamp"}


def main():
    if not OUT:
        raise SystemExit("usage: python3 -I scan_events.py <out.json>")
    a49, s49 = crawl(49)
    a161, s161 = crawl(161)
    seen = {}
    for a in a49 + a161:
        seen[a["code"]] = a
    log("articles", len(seen), "catalog49", s49["articles"], "catalog161", s161["articles"])
    intro_hash = check_intro_tokens()
    events, audit, fdelist = [], [], []
    for a in seen.values():
        title, stamp = a.get("title", ""), a.get("releaseDate")
        if not stamp or stamp < FROM_MS or stamp >= FREEZE_MS:
            continue
        if a["code"] == INTRO_CODE:
            events.append(
                {"cls": "tag", "code": a["code"], "ms": stamp, "title": title, "tokens": list(INTRO_TOKENS)}
                | {"source": "article-body"}
            )
            audit.append({"code": a["code"], "ms": stamp, "title": title, "decision": "tag", "reason": "tag-intro"})
            continue
        if not re.search(r"monitoring tag|delist", title, re.I):
            continue
        cls, toks, reason = decide(title)
        audit.append({"code": a["code"], "ms": stamp, "title": title, "decision": cls or "rejected", "reason": reason})
        if cls:
            events.append(
                {"cls": cls, "code": a["code"], "ms": stamp, "title": title, "tokens": toks} | {"source": "title"}
            )
        if reason == "futures-delist":
            syms = sorted(set(re.findall(r"\b([A-Z0-9]{2,15}USDT)\b", title)))
            fdelist.append({"code": a["code"], "ms": stamp, "title": title, "symbols": syms})
    events.sort(key=lambda e: (e["ms"], e["code"]))
    audit.sort(key=lambda r: (r["ms"], r["code"]))
    fdelist.sort(key=lambda r: (r["ms"], r["code"]))
    for entry in fdelist:
        read_futures_notice(entry)
        time.sleep(0.4)
    log("futures delisting notices", len(fdelist), "with symbols", sum(1 for r in fdelist if r["symbols"]))
    n_tag = sum(1 for e in events if e["cls"] == "tag")
    n_delist = sum(1 for e in events if e["cls"] == "delist")
    log("tag notices", n_tag, "delist notices", n_delist)
    unclassified = [r for r in audit if r["reason"] == "unclassified"]
    log("unclassified titles:", len(unclassified))
    for r in unclassified:
        log("   ", time.strftime("%Y-%m-%d", time.gmtime(r["ms"] / 1000)), r["title"][:140])
    syms = sorted({tok for e in events for tok in e["tokens"]})
    log("distinct tickers", len(syms))
    arch = {}
    for i, tok in enumerate(syms):
        cands = []
        for form in SYMBOL_FORMS:
            sym = form + tok + "USDT"
            days = archive_days(sym)
            if days:
                cands.append(span(sym, days))
            time.sleep(0.25)
        arch[tok] = {"candidates": cands}
        if i % 40 == 0:
            log("archive", i, "of", len(syms), flush=True)
    btc = span("BTCUSDT", archive_days("BTCUSDT"))
    for e in events:
        day = time.strftime("%Y-%m-%d", time.gmtime(e["ms"] / 1000))
        e["day"] = day
        e["perp"] = {tok: resolve(tok, e["code"], e["ms"], day, arch, btc, fdelist) for tok in e["tokens"]}
    meta = {
        "scan_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "catalogs": {"49": s49, "161": s161},
        "articles": len(seen),
        "from_ms": FROM_MS,
        "freeze_ms": FREEZE_MS,
        "tag_notices": n_tag,
        "delist_notices": n_delist,
        "unclassified_titles": len(unclassified),
        "intro_code": INTRO_CODE,
        "intro_body_text_sha256": intro_hash,
    }
    payload = {
        "meta": meta,
        "events": events,
        "archive": arch,
        "btc": btc,
        "audit": audit,
        "futures_delist": fdelist,
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1, sort_keys=True)
        fh.write("\n")
    for cls in ("tag", "delist"):
        evs = [e for e in events if e["cls"] == cls]
        tot = sum(len(e["tokens"]) for e in evs)
        live = sum(1 for e in evs for tok in e["tokens"] if e["perp"][tok]["symbol"])
        yrs = {}
        for e in evs:
            row = yrs.setdefault(e["day"][:4], [0, 0, 0])
            row[0] += 1
            row[1] += len(e["tokens"])
            row[2] += sum(1 for tok in e["tokens"] if e["perp"][tok]["symbol"])
        log(cls, "notices", len(evs), "tokens", tot, "with a USDT-M perp covering the stamp", live)
        log("   by year (notices, tokens, with perp):", dict(sorted(yrs.items())))
        log(
            "   notices with at least one perp token:",
            sum(1 for e in evs if any(v["symbol"] for v in e["perp"].values())),
        )


if __name__ == "__main__":
    main()
