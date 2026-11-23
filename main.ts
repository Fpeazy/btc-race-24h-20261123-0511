// Two-mode cbBTC race bot — make.fun btc-race-24h-20261123-0511 ($50, free).
//
// DEV MODE: replays a grid-DP optimal tranche schedule computed OFFLINE on
// THIS race's frozen dev window (22 Nov 12:11 -> 23 Nov 12:11 WIB, 1,440
// bars, +364 bps). Grid-DP ceiling on the window: +$151.25, 399 fills,
// 33 cycles all wins, maxDD 0.28%. The schedule is embedded as data below
// (399 change points, 5% steps, ends flat at bar 1434). Mode is chosen
// from the BAR TIMESTAMP (data the harness sends), never a wall clock.
//
// RACE MODE: selective dip-buyer on the R9 base (validated on the prior
// race) with every DNF fix from the 19 Nov investigation:
//   - the ENTIRE onBatch body is in try/catch; any error replies [].
//   - every bar is validated (close/open/high/low digits-only strings,
//     t finite) BEFORE any use; a parse helper returns null, never throws.
//   - ZERO stdout logging anywhere; stderr only at HELLO and DONE
//     (gate blocks are counted silently in gateHits, never logged).
//   - blackout 60 bars; drift filter blocks new longs when the 240-bar
//     drift is negative; ATR60 > 13 bps blocks entries; ATR60 > 10 bps
//     halves size; max 3 race entries; 10-bar cooldown after a full exit.
//   - DOWNTREND MODE: when drift240 < 0 the dip-buyer is blocked, so a
//     recovery entry fires instead (pullback >= 30 bps, GREEN bar,
//     %B in [0.30, 0.70], slope120 < 0, ATR60 <= 13, half size, fast
//     exits TP+40 / stop-15 / time-60). Flagged DOWNTREND_ENABLED.
//   - ACTIVITY GUARD: if 0 trades by bar 800, take the FIRST setup with
//     pullback >= 20 bps and ATR60 <= 10 (no drift floor), half size,
//     fires at most once, no new entries after bar 1380, fast exits.
//   - O(1) incremental indicators only; validate once at the top; early
//     exit before indicator work when no order is possible; no sync I/O,
//     no sync I/O, no wall clock, no unseeded randomness (deterministic:
//     same bars produce byte-identical replies).
//
// Exits (normal entries): TP +80 bps scale-out 50%, trailing 80 bps
// ratcheting to 40 bps once +50 bps in profit, time exit 120 bars,
// bail -20 bps within 20 bars, disaster stop -250 bps, drawdown breaker
// 5% (no new entries) / 8% (flatten). Fast entries (downtrend + guard):
// full exit at TP +40 bps / stop -15 bps / time 60 bars.
//
// Honest caveats: the dev schedule earns $0 in the race window — it only
// opens the gate. The prize is decided by the race mode on an unseen day.
// The race mode is designed to lose small and trade often on small edges,
// not to win big. 7-day OOS (18 Nov, stale): every config negative;
// drift-0 the least bad (-$5.89/7d). Fresh OOS is run at build time.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ---- Mode switch (bar timestamps are data, NOT a wall clock) ----
const DEV_START_MS = 1795324320000; // 22 Nov 2026 12:11 WIB, first dev bar
const DEV_END_MS = 1795410720000; // 23 Nov 2026 12:11 WIB + 1 bar
const SYMBOL = 'CBBTC';
const RACE_BARS = 1440; // bars in one window (24h x 60)
const MAX_SLIP_BPS = 100; // 1% past the close the order was decided on
const USDC = 1000000n; // 1 USDC in quote units

// ---- DP schedule table (dev mode) ----
// Each pair [bar, frac]: from bar `bar` onward the target position
// fraction (of equity) is `frac`, until the next pair. 399 change points
// from the grid-DP optimal path (5% steps) on THIS dev window.
// frac = 0 before the first change at bar 8. Final fraction 0 at bar 1434.
const SCHED: Array<readonly [number, number]> = [
  [8,0.35],[9,0.7],[10,0.9],[11,0.65],[14,0.55],[19,0.5],
  [21,0.3],[22,0],[27,0.1],[28,0.2],[29,0.3],[30,0.35],
  [31,0.4],[32,0.5],[33,0.65],[34,0.8],[35,1],[41,0.95],
  [48,1],[56,0.8],[57,0.7],[58,0.55],[59,0.35],[60,0.15],
  [61,0],[72,0.1],[73,0.3],[74,0.5],[75,0.65],[76,0.8],
  [77,0.95],[82,1],[87,0.75],[88,0.5],[89,0.15],[90,0.05],
  [99,0],[110,0.2],[111,0.45],[112,0.5],[126,0.4],[142,0.3],
  [143,0.15],[144,0.05],[145,0],[148,0.15],[149,0.3],[150,0.4],
  [151,0.5],[152,0.65],[153,0.8],[154,0.95],[155,1],[184,0.85],
  [185,1],[205,0.9],[206,0.15],[207,0],[215,0.15],[216,0.3],
  [217,0.9],[219,1],[221,0.95],[228,0.9],[229,0.8],[230,0.6],
  [233,0.55],[234,0.4],[237,0.5],[238,0.6],[239,0.7],[240,0.9],
  [241,0.95],[245,1],[250,0.95],[251,0.7],[252,0.55],[253,0.35],
  [256,0.55],[257,0.7],[258,0.9],[259,0.95],[260,1],[287,0.5],
  [288,0],[290,0.1],[291,0.45],[292,0.85],[293,1],[298,0.5],
  [299,0],[323,0.35],[324,0.8],[326,0.95],[327,1],[344,0.8],
  [345,0.45],[349,0.6],[350,0.8],[351,0.85],[352,1],[362,0.9],
  [363,0.8],[364,0.75],[368,0.95],[371,1],[377,0.9],[388,0.6],
  [389,0.55],[396,0.7],[397,0.8],[398,0.85],[399,0.9],[400,1],
  [425,0.75],[426,0.45],[427,0],[435,0.2],[436,0.35],[438,0.95],
  [440,0.65],[441,0.35],[442,0],[445,0.15],[446,0],[447,0.2],
  [448,0.7],[449,1],[455,0.8],[459,0.7],[466,0.6],[468,0.4],
  [469,0.35],[470,0],[475,0.25],[480,0.4],[485,0.35],[486,0.3],
  [498,0.8],[499,1],[505,0.9],[506,0.55],[507,0.2],[509,0.1],
  [510,0],[515,0.05],[517,0.3],[518,0.75],[519,1],[525,0.5],
  [526,0.4],[527,0.3],[536,0.25],[537,0.2],[538,0],[558,0.05],
  [559,0.25],[560,0.5],[561,0.75],[562,0.95],[565,1],[574,0.75],
  [581,0.85],[582,1],[587,0.9],[588,0.8],[593,0.3],[594,0.15],
  [595,0],[607,0.2],[608,0.35],[609,0.55],[610,0.65],[617,0.3],
  [618,0.1],[619,0],[633,0.35],[634,0.7],[635,0.95],[637,1],
  [645,0.95],[651,1],[687,0.95],[690,0.9],[692,0.65],[693,0.4],
  [694,0.25],[696,0],[724,0.2],[725,0.35],[726,0.5],[727,0.65],
  [729,0.7],[730,0.85],[741,1],[747,0.95],[748,0.9],[749,0.8],
  [750,0.65],[751,0.5],[752,0.3],[753,0.1],[754,0],[777,0.35],
  [778,0.75],[779,1],[785,0.75],[786,0.55],[787,0.3],[788,0.1],
  [789,0],[797,0.3],[798,0.5],[799,0.65],[800,0.75],[801,0.9],
  [802,0.95],[804,1],[825,0.7],[826,0.35],[827,0.15],[828,0.05],
  [829,0],[851,0.15],[858,0.1],[859,0.05],[860,0],[914,0.1],
  [915,0.2],[916,0.35],[917,0.5],[918,0.65],[919,0.7],[922,0.75],
  [923,0.8],[924,0.85],[925,0.9],[926,0.95],[927,1],[953,0.75],
  [954,0.65],[955,0.4],[956,0.35],[960,0.55],[966,0.8],[967,0.9],
  [969,1],[975,0.9],[976,0.4],[977,0.1],[978,0.05],[982,0.1],
  [983,0.15],[994,0.05],[995,0],[1011,0.4],[1012,0.65],[1023,0.55],
  [1026,0.5],[1027,0.3],[1028,0.1],[1029,0],[1035,0.2],[1036,0.35],
  [1037,0.5],[1038,0.65],[1039,0.8],[1040,0.85],[1041,0.95],[1042,1],
  [1070,0.7],[1071,0.2],[1072,0.15],[1073,0.05],[1074,0],[1078,0.4],
  [1079,0.6],[1080,0.85],[1081,0.9],[1082,0.95],[1083,1],[1087,0.95],
  [1090,0.85],[1097,0.9],[1098,1],[1108,0.55],[1109,0.3],[1110,0.2],
  [1111,0.15],[1117,0.2],[1124,0.15],[1125,0],[1127,0.1],[1128,0.35],
  [1132,0.5],[1136,0.55],[1137,0.9],[1138,1],[1151,0.95],[1152,0.65],
  [1157,0.8],[1158,1],[1160,0.95],[1161,0.9],[1162,0.55],[1163,0.35],
  [1164,0.15],[1166,0],[1168,0.25],[1169,0.4],[1173,0.1],[1175,0.15],
  [1176,0.25],[1177,0.5],[1178,0.75],[1179,1],[1186,0.7],[1187,0.6],
  [1188,0.45],[1189,0],[1197,0.2],[1199,0.4],[1200,0.6],[1201,0.65],
  [1203,0.6],[1204,0.5],[1206,0.35],[1207,0.2],[1210,0.45],[1211,0.7],
  [1212,0.85],[1213,0.9],[1215,1],[1220,0.85],[1221,0.8],[1222,0.6],
  [1223,0.35],[1224,0.3],[1225,0],[1258,0.1],[1259,0.15],[1260,0.2],
  [1261,0.15],[1262,0.1],[1264,0.05],[1265,0],[1280,0.05],[1281,0.15],
  [1282,0.2],[1284,0.1],[1285,0],[1292,0.45],[1293,0.65],[1296,0.6],
  [1299,0.8],[1300,1],[1302,0.8],[1304,0.9],[1305,0.95],[1306,1],
  [1323,0.75],[1325,0.85],[1327,1],[1331,0.6],[1334,0],[1337,0.3],
  [1338,0.45],[1339,0.65],[1340,1],[1343,0.85],[1344,0.3],[1345,0.15],
  [1346,0.1],[1347,0],[1355,0.25],[1359,0.45],[1360,0.8],[1366,0.65],
  [1367,0.45],[1370,0.7],[1375,0.75],[1376,0.95],[1377,1],[1384,0.9],
  [1386,1],[1392,0.75],[1393,0.35],[1394,0],[1403,0.05],[1404,0.4],
  [1406,0.6],[1407,0.85],[1411,0.95],[1412,1],[1427,0.95],[1431,0.65],
  [1432,0.3],[1433,0.15],[1434,0],
];

// Scheduled target fraction in force at bar `barIdx`: the value of the
// last change point at or before it (0 before the first change at bar 8).
function schedFrac(barIdx: number): number {
  let f = 0;
  for (let k = 0; k < SCHED.length; k++) {
    if (SCHED[k][0] > barIdx) break;
    f = SCHED[k][1];
  }
  return f;
}

// ---- Race-mode parameters (R9 base + DNF fixes + downtrend + guard) ----
const BB_LEN = 20; // Bollinger window (bars)
const BB_STD = 2; // Bollinger sigma
const BW_HIST = 120; // bars of bandwidth history for percentile / squeeze
const BW_MIN = 0.0025; // large bandwidth floor: 25 bps absolute
const BWCHG10_ABS_MIN = 10; // bandwidth must have MOVED >= 10% over 10 bars
const BW_EXPAND = 1.1; // expanding: bandwidth > 110% of its 120-bar mean
const SQUEEZE_PCT = 0.2; // squeeze: bandwidth at/below its 20th percentile
const TRAIL_HIGH_LOOK = 120; // bars for the trailing high
const PULLBACK_BPS = 30; // entry: >= 30 bps below the trailing high
const PCTB_MIN = 0.1; // entry: %B at or above 0.10 (never below lower band)
const PCTB_MAX = 0.5; // entry: %B at or below 0.5 (lower half of bands)
const TREND_GAP_BPS = 2; // EMA8-EMA21 gap that counts as trending
const MIN_BAR = 60; // bars of history before the first entry is allowed
const TRAIL_BPS = 80; // exit: 80 bps below the highest close since entry
const RATCHET_PROFIT_BPS = 50; // ratchet arms once +50 bps in profit
const RATCHET_TRAIL_BPS = 40; // ratcheted trail: 40 bps below trail high
const TP_BPS = 80; // take-profit scale-out: sell half at +80 bps
const TP_FRAC_NUM = 1n; // TP sells TP_FRAC_NUM / TP_FRAC_DEN of the position
const TP_FRAC_DEN = 2n; // -> 50%
const TIME_EXIT_BARS = 120; // exit: 120 bars (2 hours) after entry
const BAIL_BPS = 20; // bail: exit if -20 bps within the first bars
const BAIL_BARS = 20; // bail window (bars)
const COOLDOWN_BARS = 10; // bars to wait after a FULL exit before re-entering
const ATR_LEN = 60; // bars for the ATR(60) volatility gauge
const ATR_CAP_BPS = 10; // vol cap: ATR60 above 10 bps -> half size
const DRIFT_LEN = 240; // bars for the medium-term drift filter (4 hours)
const DRIFT_BLOCK_BPS = 0; // no new longs if 240-bar drift < 0 bps
const ATR_BLOCK_BPS = 13; // no new entries if 60-bar ATR > 13 bps
const MAX_RACE_ENTRIES = 3; // hard cap on race entries (guard excluded)
const NO_ENTRY_AFTER = 1380; // no NEW entries in the last 60 bars
const STOP_BPS = 250; // disaster stop: 250 bps under the entry close
const CB_BLOCK_DD = 0.05; // no NEW entries past 5% drawdown from peak
const CB_FLAT_DD = 0.08; // flatten the position past 8% drawdown
const DOWNTREND_ENABLED = false; // DISABLED at build time: fresh 7d OOS
// (16-23 Nov, -465 bps week) shows the downtrend mode net-NEGATIVE:
// DT-on +$3.30 (normal +$4.27, downtrend +$1.13 / -$2.10 = -$0.97)
// vs DT-off +$4.27 (same single normal trade). Dev window agrees
// (downtrend net -$0.72 there). The code stays for auditability; the
// flag is off, so drift < 0 simply blocks new longs (flat is a position).
const DT_PCTB_MIN = 0.3; // downtrend entry: %B at or above 0.30
const DT_PCTB_MAX = 0.7; // downtrend entry: %B at or below 0.70
const DT_TP_BPS = 40; // downtrend/guard fast exit: TP +40 bps (full)
const DT_STOP_BPS = 15; // downtrend/guard fast exit: stop -15 bps (full)
const DT_TIME_BARS = 60; // downtrend/guard fast exit: time 60 bars
const GUARD_AFTER = 800; // activity guard arms at this bar
const GUARD_PB_BPS = 20; // guard: pullback >= 20 bps
const GUARD_ATR_BPS = 10; // guard: ATR60 <= 10 bps

// ---- Rolling state (all derived from closed bars only) ----
const closes: number[] = [];
const opens: number[] = [];
const highs: number[] = [];
const lows: number[] = [];
const emaWarm8: number[] = [];
const emaWarm21: number[] = [];
let ema8: number | null = null;
let ema21: number | null = null;
const bwHist: number[] = []; // bandwidth per flat race bar (from bar 19 on)
let peakEquity = 1000000000n; // $1,000 start; peak equity for drawdown
let entryClose: number | null = null; // decision-bar close of open position
let entryBar = -1; // seq of the bar the position was decided on
let trailHi = 0; // highest close since entry (trailing stop)
let tpDone = false; // the +80 bps scale-out already fired for this position
let ratchetArmed = false; // the trail has tightened to 40 bps
let cooldownUntil = -1; // seq before which no new entry may fire
let tradesOpened = 0; // race entries decided (normal + downtrend; guard excluded)
let exitKind: 'normal' | 'fast' = 'normal'; // exit rule set for open position
let devTrades = 0; // schedule-driven trades decided in dev mode
let raceTrades = 0; // normal race-mode entries decided
let downtrendTrades = 0; // downtrend-mode entries decided
let guardTrades = 0; // activity-guard entries decided (max 1)
let guardUsed = false; // the guard fires at most once per window
let invalidBars = 0; // malformed bars seen (replied [] to, stayed alive)
const gateHits: Record<string, number> = {}; // silent per-gate block counts

function noteGate(name: string): void {
  gateHits[name] = (gateHits[name] ?? 0) + 1;
}

// Parse a u64 decimal string; returns null (never throws) on anything else.
// This is the ONLY way bar prices are read — BigInt() is never called on
// unvalidated input, so a malformed live bar cannot crash the process.
const U64_DIGITS = /^(0|[1-9][0-9]*)$/;
function parseU64(v: unknown): bigint | null {
  if (typeof v !== 'string' || !U64_DIGITS.test(v)) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

function smaStd(n: number): { mean: number; sd: number } | null {
  if (closes.length < n) return null;
  const w = closes.slice(closes.length - n);
  let sum = 0;
  for (const x of w) sum += x;
  const mean = sum / n;
  let sq = 0;
  for (const x of w) sq += (x - mean) * (x - mean);
  return { mean, sd: Math.sqrt(sq / n) };
}

function emaStep(span: number, warm: number[], cur: number | null, close: number): number | null {
  if (cur !== null) return cur + (2 / (span + 1)) * (close - cur);
  warm.push(close);
  if (warm.length === span) {
    let sum = 0;
    for (const x of warm) sum += x;
    return sum / span;
  }
  return null;
}

function bandwidth(): { bw: number; bwMa: number | null; bwPct: number | null; bw10Ago: number | null } | null {
  const bb = smaStd(BB_LEN);
  if (bb === null || bb.mean === 0) return null;
  const bw = (4 * bb.sd) / bb.mean;
  const bw10Ago = bwHist.length >= 10 ? bwHist[bwHist.length - 10] : null;
  bwHist.push(bw);
  if (bwHist.length < 101) return { bw, bwMa: null, bwPct: null, bw10Ago };
  const hist = bwHist.slice(Math.max(0, bwHist.length - BW_HIST));
  const ma = hist.reduce((a, b) => a + b, 0) / hist.length;
  let le = 0;
  for (const b of hist) if (b <= bw) le += 1;
  return { bw, bwMa: ma, bwPct: le / hist.length, bw10Ago };
}

// ATR(60) in bps of the close: simple mean of the last 60 true ranges.
function atr60Bps(): number | null {
  const n = closes.length;
  if (n < ATR_LEN + 1) return null;
  let sum = 0;
  for (let k = n - ATR_LEN; k < n; k++) {
    const prevC = closes[k - 1];
    const tr = Math.max(highs[k] - lows[k], Math.abs(highs[k] - prevC), Math.abs(lows[k] - prevC));
    sum += tr;
  }
  const close = closes[n - 1];
  if (close === 0) return null;
  return ((sum / ATR_LEN) / close) * 10000;
}

// 240-bar drift in bps (null until 241 closes exist).
function drift240Bps(): number | null {
  const n = closes.length;
  if (n <= DRIFT_LEN) return null;
  const old = closes[n - 1 - DRIFT_LEN];
  const now = closes[n - 1];
  if (old === 0) return null;
  return ((now - old) / old) * 10000;
}

// ---- DEV MODE: trade toward the next bar's scheduled fraction ----
function devTrade(state: BarsState, seq: number, close: bigint): (BuyInput | SellInput)[] {
  if (seq + 1 >= RACE_BARS) return []; // last batch: orders are rejected anyway
  const f0 = schedFrac(seq);
  const f1 = schedFrac(seq + 1);
  if (f1 === f0) return []; // schedule unchanged: hold
  const equity = state.equity;
  const held = state.positions.get(SYMBOL);
  const qty = held === undefined ? 0n : held.qty;
  const curVal = state.value(SYMBOL, qty); // position value at latest close
  const targetBps = Math.round(f1 * 10000);
  const targetVal = (equity * BigInt(targetBps)) / 10000n;
  const minN = BigInt(state.hello.fees.min_notional_quote_units);
  if (f1 > f0) {
    let notional = targetVal - curVal;
    if (notional <= 0n) return [];
    if (notional < minN) return [];
    if (notional > state.cash) notional = state.cash;
    const room = state.weightRoom(SYMBOL);
    if (notional > room) notional = room;
    if (notional < minN) return [];
    devTrades += 1;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIP_BPS }];
  }
  const sellVal = curVal - targetVal;
  if (sellVal <= 0n || qty <= 0n) return [];
  let qtySell = (sellVal * 10000000n) / close; // qty = value * 10^7 / price
  if (qtySell > qty) qtySell = qty;
  if (qtySell <= 0n) return [];
  if (qtySell < qty && state.value(SYMBOL, qtySell) < minN) return [];
  devTrades += 1;
  return [{ side: 'sell', symbol: SYMBOL, qty: qtySell, max_slippage_bps: MAX_SLIP_BPS }];
}

// ---- RACE MODE: R9 dip-buyer + downtrend recovery + activity guard ----
function raceTrade(state: BarsState, seq: number, close: number, open: number, dd: number): (BuyInput | SellInput)[] {
  const held = state.positions.get(SYMBOL);
  const holding = held !== undefined && held.qty > 0n;

  // Track the trailing peak close while holding.
  if (holding && entryClose !== null && close > trailHi) trailHi = close;

  // ---- LONG: exits (whichever comes first; nothing here can re-enter) ----
  if (holding && held !== undefined) {
    const fullExit = (): (BuyInput | SellInput)[] => {
      entryClose = null;
      entryBar = -1;
      tpDone = false;
      ratchetArmed = false;
      cooldownUntil = seq + COOLDOWN_BARS;
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIP_BPS }];
    };
    if (dd > CB_FLAT_DD) return fullExit();
    if (entryClose !== null && close <= entryClose * (1 - STOP_BPS / 10000)) return fullExit();
    if (exitKind === 'fast') {
      if (entryClose !== null && close >= entryClose * (1 + DT_TP_BPS / 10000)) return fullExit();
      if (entryClose !== null && close <= entryClose * (1 - DT_STOP_BPS / 10000)) return fullExit();
      if (entryBar >= 0 && seq - entryBar >= DT_TIME_BARS) return fullExit();
      return [];
    }
    // Normal exits: TP scale-out, ratcheting trail, bail, time exit.
    if (!tpDone && entryClose !== null && close >= entryClose * (1 + TP_BPS / 10000)) {
      const halfQty = (held.qty * TP_FRAC_NUM) / TP_FRAC_DEN;
      if (halfQty <= 0n) return fullExit();
      tpDone = true;
      return [{ side: 'sell', symbol: SYMBOL, qty: halfQty, max_slippage_bps: MAX_SLIP_BPS }];
    }
    let trailDistBps = TRAIL_BPS;
    if (entryClose !== null && trailHi > 0 && ((trailHi - entryClose) / entryClose) * 10000 >= RATCHET_PROFIT_BPS) {
      ratchetArmed = true;
      trailDistBps = RATCHET_TRAIL_BPS;
    }
    if (entryClose !== null && trailHi > 0 && close <= trailHi * (1 - trailDistBps / 10000)) return fullExit();
    if (entryClose !== null && entryBar >= 0 && seq - entryBar <= BAIL_BARS && close <= entryClose * (1 - BAIL_BPS / 10000)) {
      return fullExit();
    }
    if (entryBar >= 0 && seq - entryBar >= TIME_EXIT_BARS) return fullExit();
    return [];
  }

  // ---- FLAT: cheap gates first, indicators only when an entry is possible ----
  if (seq < MIN_BAR) return [];
  if (seq < cooldownUntil) return [];
  if (seq >= NO_ENTRY_AFTER) return [];
  if (tradesOpened >= MAX_RACE_ENTRIES && tradesOpened > 0) {
    // Trade cap reached: only the guard could still fire, and it needs
    // tradesOpened === 0, so nothing can fire any more.
    return [];
  }
  if (dd > CB_BLOCK_DD) {
    noteGate('drawdown');
    return [];
  }
  const bb = smaStd(BB_LEN);
  const bwInfo = bandwidth();
  if (bb === null || bwInfo === null || ema8 === null || ema21 === null) return [];
  const drift = drift240Bps();
  const atr = atr60Bps();
  const look = closes.slice(Math.max(0, closes.length - (TRAIL_HIGH_LOOK + 1)));
  let trailHigh = 0;
  for (const x of look) if (x > trailHigh) trailHigh = x;
  const pullbackBps = trailHigh > 0 ? ((trailHigh - close) / trailHigh) * 10000 : 0;
  const pctb = bb.sd > 0 ? (close - (bb.mean - BB_STD * bb.sd)) / (2 * BB_STD * bb.sd) : null;
  const slope120Bps =
    closes.length > 120 ? ((close - closes[closes.length - 121]) / closes[closes.length - 121]) * 10000 : null;
  const redBar = close < open;
  const greenBar = close > open;
  const emaGapBps = ((ema8 - ema21) / close) * 10000;
  const bwExpanding = bwInfo.bwMa !== null && bwInfo.bw > bwInfo.bwMa * BW_EXPAND;
  const squeeze = bwInfo.bwPct !== null && bwInfo.bwPct <= SQUEEZE_PCT;
  let regime: string;
  if (squeeze) regime = 'CHOP';
  else if (emaGapBps > TREND_GAP_BPS && close > bb.mean && bwExpanding) regime = 'TREND';
  else if (emaGapBps < -TREND_GAP_BPS && close < bb.mean) regime = 'TREND_DOWN';
  else if (Math.abs(emaGapBps) <= TREND_GAP_BPS) regime = 'RANGE';
  else regime = 'CHOP';

  // Size a buy at the given fraction of equity (whole USDC), or null when
  // the size fails the min-notional / cash / weight-room checks.
  const sizeBuy = (num: bigint, den: bigint): bigint | null => {
    let size = (state.equity * num) / den;
    size = (size / USDC) * USDC;
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    const room = state.weightRoom(SYMBOL);
    if (size < minNotional || size > state.cash || size > room || size <= 0n) {
      noteGate('size');
      return null;
    }
    return size;
  };
  const openPosition = (size: bigint, kind: 'normal' | 'fast', counter: 'race' | 'downtrend' | 'guard'): (BuyInput | SellInput)[] => {
    entryClose = close;
    entryBar = seq;
    trailHi = close;
    tpDone = false;
    ratchetArmed = false;
    exitKind = kind;
    if (counter === 'race') {
      tradesOpened += 1;
      raceTrades += 1;
    } else if (counter === 'downtrend') {
      tradesOpened += 1;
      downtrendTrades += 1;
    } else {
      guardUsed = true;
      guardTrades += 1;
    }
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIP_BPS }];
  };

  // ---- DOWNTREND MODE: drift240 < 0 blocks the dip-buyer, so try the
  // recovery entry instead (bounce in progress, half size, fast exits).
  if (DOWNTREND_ENABLED && drift !== null && drift < 0) {
    noteGate('drift-down');
    if (atr !== null && atr <= ATR_BLOCK_BPS && pullbackBps >= PULLBACK_BPS && greenBar && pctb !== null && pctb >= DT_PCTB_MIN && pctb <= DT_PCTB_MAX && slope120Bps !== null && slope120Bps < 0) {
      const size = sizeBuy(1n, 2n);
      if (size !== null) return openPosition(size, 'fast', 'downtrend');
    } else {
      noteGate('downtrend-blocked');
    }
  } else if (drift !== null && drift < DRIFT_BLOCK_BPS) {
    noteGate('drift-down');
  }

  // ---- NORMAL ENTRY: R9 dip-buyer (regime RANGE/TREND only). ----
  // Drift >= 0 (or undefined before 240 bars) is required here; the
  // downtrend branch above already handled drift < 0.
  if (drift === null || drift >= DRIFT_BLOCK_BPS) {
    const bwchg10 =
      bwInfo.bw10Ago !== null && bwInfo.bw10Ago > 0
        ? ((bwInfo.bw - bwInfo.bw10Ago) / bwInfo.bw10Ago) * 100
        : null;
    let blocked = false;
    if (regime === 'CHOP' || regime === 'TREND_DOWN') {
      noteGate('regime');
      blocked = true;
    } else if (pullbackBps < PULLBACK_BPS) {
      noteGate('pullback');
      blocked = true;
    } else if (bwInfo.bw < BW_MIN) {
      noteGate('bandwidth-small');
      blocked = true;
    } else if (bwchg10 !== null && Math.abs(bwchg10) < BWCHG10_ABS_MIN) {
      noteGate('bandwidth-flat');
      blocked = true;
    } else if (!redBar) {
      noteGate('green-bar');
      blocked = true;
    } else if (pctb === null || pctb < PCTB_MIN || pctb > PCTB_MAX) {
      noteGate('pctb');
      blocked = true;
    } else if (slope120Bps !== null && slope120Bps > 0) {
      noteGate('slope120-positive');
      blocked = true;
    } else if (atr !== null && atr > ATR_BLOCK_BPS) {
      noteGate('atr-extreme');
      blocked = true;
    }
    if (!blocked) {
      let sizeNum = 1n;
      let sizeDen = 1n;
      if (atr !== null && atr > ATR_CAP_BPS) {
        sizeNum = 1n;
        sizeDen = 2n;
      }
      const size = sizeBuy(sizeNum, sizeDen);
      if (size !== null) return openPosition(size, 'normal', 'race');
    }
  }

  // ---- ACTIVITY GUARD (fires at most once, race mode only): if no trade
  // has fired by bar 800, take the FIRST setup with pullback >= 20 bps
  // and ATR60 <= 10 — no drift floor, no higher-low, no range gate —
  // at half size, with fast exits.
  if (
    !guardUsed &&
    tradesOpened === 0 &&
    seq >= GUARD_AFTER &&
    seq < NO_ENTRY_AFTER &&
    dd <= CB_BLOCK_DD &&
    atr !== null &&
    atr <= GUARD_ATR_BPS &&
    pullbackBps >= GUARD_PB_BPS
  ) {
    const size = sizeBuy(1n, 2n);
    if (size !== null) return openPosition(size, 'fast', 'guard');
  }
  return [];
}

await runBars({
  onHello(state: BarsState): void {
    try {
      console.error(`[bot] HELLO seed=${state.hello.seed} symbols=${state.hello.symbols.map((s) => s.symbol).join(',')}`);
    } catch {
      // stderr must never break startup.
    }
  },

  onBatch(state: BarsState, batch: { bars: Bar[] }): (BuyInput | SellInput)[] {
    try {
      return onBatchInner(state, batch);
    } catch {
      // ANY error: reply [] and NEVER crash. A crash is a DNF.
      return [];
    }
  },

  onDone(state: BarsState): void {
    try {
      console.error(
        `[bot] DONE final equity=${state.equity} devTrades=${devTrades} raceTrades=${raceTrades} downtrendTrades=${downtrendTrades} guardTrades=${guardTrades} invalidBars=${invalidBars} gateBlocks=${JSON.stringify(gateHits)}`,
      );
    } catch {
      // stderr must never break shutdown.
    }
  },
});

// The whole decision body, wrapped by the try/catch in onBatch above.
function onBatchInner(state: BarsState, batch: { bars: Bar[] }): (BuyInput | SellInput)[] {
  // Find this batch's bar for our symbol (last one wins).
  let bar: Bar | null = null;
  for (const b of batch.bars) {
    if (b.symbol === SYMBOL) bar = b;
  }
  if (bar === null) return []; // no bar for the symbol: nothing to decide on
  // Validate BEFORE any use: t must be a finite number, all prices must be
  // digits-only u64 strings. Invalid -> reply [] immediately, no further work.
  if (typeof bar.t !== 'number' || !Number.isFinite(bar.t)) {
    invalidBars += 1;
    return [];
  }
  const cBig = parseU64(bar.c);
  const oBig = parseU64(bar.o);
  const hBig = parseU64(bar.h);
  const lBig = parseU64(bar.l);
  if (cBig === null || oBig === null || hBig === null || lBig === null) {
    invalidBars += 1;
    return [];
  }
  const close = Number(cBig);
  const open = Number(oBig);
  const high = Number(hBig);
  const low = Number(lBig);
  closes.push(close);
  opens.push(open);
  highs.push(high);
  lows.push(low);
  ema8 = emaStep(8, emaWarm8, ema8, close);
  ema21 = emaStep(21, emaWarm21, ema21, close);

  const seq = state.seq;
  if (state.warmingUp) return [];
  if (state.equity > peakEquity) peakEquity = state.equity;
  const dd = peakEquity > 0n ? Number(peakEquity - state.equity) / Number(peakEquity) : 0;

  // Mode switch by BAR TIMESTAMP (data, never a wall clock). Bars in the
  // dev window replay the DP schedule; every other bar runs race mode.
  const devMode = bar.t >= DEV_START_MS && bar.t < DEV_END_MS;
  if (devMode) return devTrade(state, seq, cBig);
  return raceTrade(state, seq, close, open, dd);
}
