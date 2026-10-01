#!/usr/bin/env node
/**
 * Step 0 of the demo-execution work: a READ-ONLY probe of the Binance demo
 * account. It places no order, cancels nothing and changes no setting.
 *
 * It exists because three things must be true before any order code is worth
 * writing, and none of them can be assumed:
 *
 *   1. The demo account is reachable and the keys are accepted.
 *   2. The account is in one-way mode, since the mirror sends reduce-only
 *      orders and `reduceOnly` is rejected in Hedge Mode.
 *   3. The ALGO endpoints answer. Since 2025-12-09 conditional orders must go
 *      to `/fapi/v1/algoOrder`, and `/fapi/v1/order` rejects them with
 *      `-4120 STOP_ORDER_SWITCH_ALGO`. If the demo account has no algo
 *      service, the mirror cannot place a stop at all and the design changes.
 *
 * Deliberately self-contained: Node builtins only, no imports from the app, so
 * it runs on the VPS with plain `node` and needs no image build.
 *
 * It prints shapes, counts and booleans. It never prints the key, the secret,
 * a signature, or a full response body.
 *
 * Run it on the VPS, where Binance is reachable (the home ISP blocks it):
 *
 *   cd /opt/sites/crypto
 *   set -a; . ./.env; set +a
 *   node scripts/ops/demo-probe.mjs
 */
import { createHmac } from 'node:crypto';

const BASE = 'https://demo-fapi.binance.com';
/** Live, read-only, public only: used solely to diff the venue filters. */
const LIVE_BASE = 'https://fapi.binance.com';
const SIGNAL_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
];
const KEY = process.env.BINANCE_DEMO_API_KEY;
const SECRET = process.env.BINANCE_DEMO_API_SECRET;

/** Anything that could carry a credential is replaced before printing. */
function redact(text) {
  let out = String(text);
  for (const secret of [KEY, SECRET]) {
    if (secret && secret.length > 4) out = out.split(secret).join('[redacted]');
  }
  return out.replace(/signature=[0-9a-f]+/gi, 'signature=[redacted]');
}

function log(...parts) {
  console.log(redact(parts.join(' ')));
}

async function call(path, { signed = false, params = {}, base = BASE } = {}) {
  const query = new URLSearchParams(params);
  if (signed) {
    query.set('timestamp', String(Date.now()));
    query.set('recvWindow', '5000');
    query.set('signature', createHmac('sha256', SECRET).update(query.toString()).digest('hex'));
  }
  const url = `${base}${path}${query.size > 0 ? `?${query}` : ''}`;
  const started = Date.now();
  const res = await fetch(url, {
    method: 'GET',
    headers: signed ? { 'X-MBX-APIKEY': KEY } : {},
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 200);
  }
  return { ok: res.ok, status: res.status, ms: Date.now() - started, body };
}

/** A Binance error body, summarised without echoing anything else. */
function errorOf(result) {
  const b = result.body;
  if (b && typeof b === 'object' && 'code' in b) return `code ${b.code}: ${b.msg}`;
  return `HTTP ${result.status}`;
}

async function main() {
  log('Binance demo probe, READ ONLY. Base:', BASE);
  log('key present:', Boolean(KEY), ' secret present:', Boolean(SECRET));
  if (!KEY || !SECRET) {
    log('');
    log('FAIL: set BINANCE_DEMO_API_KEY and BINANCE_DEMO_API_SECRET first.');
    log('On the VPS they belong in /opt/sites/crypto/.env; source it before running:');
    log('  set -a; . ./.env; set +a');
    process.exit(1);
  }

  const findings = {};

  // 1. Public reachability, and whether the DEMO venue filters match the LIVE
  //    ones the trade-plan ticket was built from. They are not guaranteed to:
  //    the demo venue carries its own filters, so an order sized against live
  //    filters can be rejected on demo, or vice versa.
  const info = await call('/fapi/v1/exchangeInfo');
  log('');
  log('1. exchangeInfo     ', info.ok ? `ok (${info.ms}ms)` : `FAILED ${errorOf(info)}`);
  if (info.ok && Array.isArray(info.body?.symbols)) {
    log('   symbols on demo   ', info.body.symbols.length);
    findings.exchangeInfo = true;

    const live = await call('/fapi/v1/exchangeInfo', { base: LIVE_BASE });
    log('   live exchangeInfo ', live.ok ? `ok (${live.ms}ms)` : `FAILED ${errorOf(live)}`);

    const filtersOf = (body, symbol) => {
      const s = body?.symbols?.find((x) => x.symbol === symbol && x.contractType === 'PERPETUAL');
      if (!s) return null;
      const lot = s.filters.find((f) => f.filterType === 'LOT_SIZE');
      const notional = s.filters.find((f) => f.filterType === 'MIN_NOTIONAL');
      const price = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
      return {
        status: s.status,
        stepSize: lot?.stepSize,
        minQty: lot?.minQty,
        minNotional: notional?.notional,
        tickSize: price?.tickSize,
      };
    };

    const mismatches = [];
    for (const symbol of SIGNAL_SYMBOLS) {
      const d = filtersOf(info.body, symbol);
      const l = live.ok ? filtersOf(live.body, symbol) : null;
      if (!d) {
        mismatches.push(`${symbol}: ABSENT on demo`);
        continue;
      }
      if (!l) continue;
      const differing = ['stepSize', 'minQty', 'minNotional', 'tickSize'].filter(
        (f) => String(d[f]) !== String(l[f])
      );
      if (differing.length > 0) {
        mismatches.push(
          `${symbol}: ${differing.map((f) => `${f} demo=${d[f]} live=${l[f]}`).join(' ')}`
        );
      }
    }
    findings.symbolsPresent = SIGNAL_SYMBOLS.every((sym) => filtersOf(info.body, sym) !== null);
    findings.filtersMatchLive = live.ok && mismatches.length === 0;
    log('   all 10 symbols    ', findings.symbolsPresent);
    if (mismatches.length === 0) {
      log('   filters vs live   ', live.ok ? 'identical' : 'not compared');
    } else {
      log('   filters vs live   ', `${mismatches.length} differ:`);
      for (const m of mismatches) log('     ', m);
    }
  }

  // 2. The keys and the balance. v3 is the current account endpoint, but it
  //    DROPPED the permission flags, so `canTrade` and `feeTier` have to come
  //    from v2. Checking them on v3 silently reads undefined.
  const account = await call('/fapi/v3/account', { signed: true });
  log('');
  log('2. v3/account       ', account.ok ? `ok (${account.ms}ms)` : `FAILED ${errorOf(account)}`);
  if (account.ok) {
    const usdt = (account.body.assets ?? []).find((a) => a.asset === 'USDT');
    log('   walletBalance USDT', usdt?.walletBalance ?? 'none');
    log('   availableBalance  ', account.body.availableBalance ?? 'none');
    findings.account = true;
    findings.balance = Number(usdt?.walletBalance ?? 0);
  } else {
    findings.account = false;
  }

  const perms = await call('/fapi/v2/account', { signed: true });
  log('   v2/account        ', perms.ok ? `ok (${perms.ms}ms)` : `FAILED ${errorOf(perms)}`);
  if (perms.ok) {
    log('   canTrade          ', perms.body.canTrade);
    log('   feeTier           ', perms.body.feeTier);
    log('   multiAssetsMargin ', perms.body.multiAssetsMargin);
    findings.canTrade = perms.body.canTrade === true;
    findings.feeTier = perms.body.feeTier;
    findings.multiAssets = perms.body.multiAssetsMargin === true;
  }

  // 3. One-way vs Hedge Mode. reduceOnly is rejected in Hedge Mode, so the
  //    mirror's exits depend on this being false.
  const dual = await call('/fapi/v1/positionSide/dual', { signed: true });
  log('');
  log('3. positionSide/dual', dual.ok ? `ok (${dual.ms}ms)` : `FAILED ${errorOf(dual)}`);
  if (dual.ok) {
    log('   dualSidePosition  ', dual.body.dualSidePosition, dual.body.dualSidePosition ? '(HEDGE MODE)' : '(one-way)');
    findings.oneWay = dual.body.dualSidePosition === false;
  }

  // 4. Open positions: the mirror must start from a flat account.
  const risk = await call('/fapi/v3/positionRisk', { signed: true });
  log('');
  log('4. v3/positionRisk  ', risk.ok ? `ok (${risk.ms}ms)` : `FAILED ${errorOf(risk)}`);
  if (risk.ok && Array.isArray(risk.body)) {
    const open = risk.body.filter((p) => Number(p.positionAmt) !== 0);
    log('   rows returned     ', risk.body.length);
    log('   open positions    ', open.length);
    for (const p of open) log(`   HELD ${p.symbol} amt=${p.positionAmt} entry=${p.entryPrice}`);
    findings.flat = open.length === 0;
  }

  // 5. Resting non-conditional orders.
  const openOrders = await call('/fapi/v1/openOrders', { signed: true });
  log('');
  log('5. openOrders       ', openOrders.ok ? `ok (${openOrders.ms}ms)` : `FAILED ${errorOf(openOrders)}`);
  if (openOrders.ok && Array.isArray(openOrders.body)) {
    log('   resting orders    ', openOrders.body.length);
  }

  // 6. THE DECIDING CHECK. Conditional orders moved to the algo service on
  //    2025-12-09. If these endpoints are absent on demo, a stop cannot be
  //    placed there and PR 3 needs a different design.
  const openAlgo = await call('/fapi/v1/openAlgoOrders', { signed: true });
  log('');
  log('6. openAlgoOrders   ', openAlgo.ok ? `ok (${openAlgo.ms}ms)` : `FAILED ${errorOf(openAlgo)}`);
  findings.algoRead = openAlgo.ok;
  if (openAlgo.ok) {
    const rows = Array.isArray(openAlgo.body) ? openAlgo.body : openAlgo.body?.orders;
    log('   open algo orders  ', Array.isArray(rows) ? rows.length : 'shape unexpected');
  }

  const allAlgo = await call('/fapi/v1/allAlgoOrders', { signed: true, params: { symbol: 'BTCUSDT', limit: '5' } });
  log('7. allAlgoOrders    ', allAlgo.ok ? `ok (${allAlgo.ms}ms)` : `FAILED ${errorOf(allAlgo)}`);
  findings.algoHistory = allAlgo.ok;

  // 8. Whether the demo account exposes sub-accounts, which decides whether
  //    one demo account can ever hold more than one book.
  const subs = await call('/fapi/v1/apiTradingStatus', { signed: true });
  log('');
  log('8. apiTradingStatus ', subs.ok ? `ok (${subs.ms}ms)` : `FAILED ${errorOf(subs)}`);

  log('');
  log('=== verdict ===');
  const checks = [
    ['public data reachable', findings.exchangeInfo === true],
    ['keys accepted', findings.account === true],
    ['account can trade', findings.canTrade === true],
    ['one-way mode (reduceOnly usable)', findings.oneWay === true],
    ['account is flat', findings.flat === true],
    ['algo endpoints readable', findings.algoRead === true],
    ['all ten signal symbols tradable', findings.symbolsPresent === true],
  ];
  for (const [label, ok] of checks) log(` ${ok ? 'PASS' : 'FAIL'}  ${label}`);

  log('');
  if (findings.algoRead !== true) {
    log('STOP: the algo endpoints did not answer. Conditional orders must go through');
    log('them since 2025-12-09, so the mirror cannot place a stop on this account.');
    log('Do not write order code until this is resolved.');
  } else if (findings.oneWay !== true) {
    log('STOP: the account is in Hedge Mode. Binance rejects reduceOnly there, which');
    log('every mirror exit relies on. Switch the demo account to one-way mode first.');
  } else if (findings.canTrade !== true || findings.account !== true) {
    log('STOP: the keys were refused or the account cannot trade.');
  } else {
    log('Clear to proceed to the signed client and a DRY RUN mirror.');
    log(`Demo USDT balance: ${findings.balance}, feeTier ${findings.feeTier}.`);
    if (findings.filtersMatchLive === false) {
      log('');
      log('NOTE: the demo venue filters differ from live (listed above). The mirror must');
      log('size orders against the DEMO filters it reads at runtime, not against the live');
      log('table the trade-plan ticket uses, or orders will be rejected or mis-rounded.');
    }
    log('Nothing was placed or changed by this probe.');
  }
}

main().catch((error) => {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
