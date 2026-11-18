// Harbor impulse-latch bot for btc-race-24h-20261118-1444 (agent-fun/bars-replay/v1).
//
// Strategy (original design, written for this race): a long-only, single-asset trend
// system for cbBTC/USDC minute bars that stays in cash unless the market proves a
// strong, broad impulse, rides that impulse at near-full weight, and then latches
// shut for hours so it cannot bleed fees in the chop that follows.
//
// Why it is shaped this way: a round trip costs the 4 bps fee + 2 bps slippage on
// both sides plus constant-product price impact against a ~$1M pool, roughly
// 25-35 bps all-in at this capital. Any system that trades often on 1-minute bars
// donates that spread to the pool (the kit's own fast baselines lose 2-15% on the
// dev window doing exactly that). So this bot trades rarely and decisively:
//
//   ENTRY (flat, latch open): all three must hold on the same close --
//     * 60-bar momentum above +0.40% (a real impulse, not noise: per-minute
//       volatility on this pool is ~0.07%),
//     * 240-bar momentum above +0.40% (the impulse agrees with the 4-hour trend,
//       so a one-hour bounce inside a downtrend never triggers it),
//     * close above the 240-bar EMA by +0.10% (price has reclaimed its trend line).
//     Size: 97% of equity, scaled down only when realised volatility is extreme
//     (per-minute vol above ~0.09%: size *= 0.09%/vol, floored at 0.55x).
//   EXIT (long): the first of --
//     * 60-bar momentum below -0.25% (impulse is over),
//     * close back under the 240-bar EMA by 0.10% (trend reclaimed),
//     * trailing stop: close 1.6% under the highest close since entry,
//     * hard stop: position worth 3% less than its cost,
//     * equity brake: equity 6% under its peak (flatten + latch).
//     After any exit the latch stays shut for 480 bars (8 hours): the hours after
//     a trend leg are exactly when lagging indicators keep re-firing into chop.
//   FALLBACK (race guardrails ask for at least one trade): if no entry has fired
//     by scored bar 1000, the thresholds relax (momentum +0.25% / +0.10%, half
//     weight) so a quiet day still produces one careful trade instead of none.
//   No new entries in the last 15 scored bars (a fill there is flattened at once).
//   If equity ever falls under 85% of the start, entries stop for the run; the
//   race's drawdown guardrail is 25%, and this keeps a bad day far from it.
//
// Determinism: decisions use only + - * /, Math.sqrt/min/max on float64 and the
// bars themselves -- no clock, no randomness, no environment -- so two runs of
// the same window produce byte-identical orders.

import { runBars, type BarsState } from './vendor/makefun-bars.ts';

const EMA_SPAN = 240; // trend line, seeded as the SMA of its first span of closes
const MOM_FAST = 60; // impulse horizon (bars)
const MOM_SLOW = 240; // trend horizon (bars)
const ENTER_M60 = 0.004; // +0.40%
const ENTER_M240 = 0.004; // +0.40%
const ENTER_BAND = 0.001; // close must clear the EMA by +0.10%
const EXIT_M60 = -0.0025; // impulse dead at -0.25%
const EXIT_BAND = 0.001; // or close 0.10% back under the EMA
const TRAIL = 0.016; // trailing stop, 1.6% under the in-position peak close
const HARD = 0.03; // hard stop, 3% under cost
const WEIGHT = 0.97; // share of equity deployed on a confirmed impulse
const LOCKOUT = 480; // bars of silence after an exit
const FALLBACK_BAR = 1000; // relax the gate if nothing has fired by here
const FALLBACK_M60 = 0.0025;
const FALLBACK_M240 = 0.001;
const FALLBACK_WEIGHT = 0.5;
const VOL_REF = 0.0009; // per-minute vol where the size scaler starts biting
const VOL_MIN_SCALE = 0.55;
const DD_BRAKE = 0.06; // flatten when equity is 6% under its peak
const HALT_FRACTION = 0.85; // stop entering under 85% of the starting equity
const LAST_ENTRY_BAR = 1425; // of the 1440 scored bars
const MAX_SLIPPAGE_BPS = 100;

// Indicator + latch state (module scope; one run, one universe).
const closes: number[] = [];
let ema: number | null = null;
let seedSum = 0;
let seedCount = 0;
let prevClose: number | null = null;
let volEmaSq: number | null = null; // EMA of squared 1-bar returns (span 120)
let peakEquity = 0;
let initialEquity = 0;
let lockoutUntil = -1; // scored-bar index from which entries are allowed again
let peakInPosition = 0; // highest close since the current position was opened
let enteredOnce = false;
let halted = false;
let wasLong = false;

function pushIndicators(close: number): void {
  if (prevClose !== null) {
    const r = (close - prevClose) / prevClose;
    volEmaSq = volEmaSq === null ? r * r : volEmaSq + (2 / 121) * (r * r - volEmaSq);
  }
  prevClose = close;
  closes.push(close);
  if (ema === null) {
    seedSum += close;
    seedCount++;
    if (seedCount === EMA_SPAN) ema = seedSum / EMA_SPAN;
  } else {
    ema += (2 / (EMA_SPAN + 1)) * (close - ema);
  }
}

await runBars({
  onBatch(state: BarsState) {
    const symbol = state.hello.symbols[0]!.symbol;
    const bar = state.latest.get(symbol);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    pushIndicators(close);
    if (initialEquity === 0) initialEquity = Number(state.hello.capital.quote_units);
    const equity = Number(state.equity);
    if (equity > peakEquity) peakEquity = equity;

    const held = state.positions.get(symbol);
    const isLong = held !== undefined && held.qty > 0n;
    if (isLong && !wasLong) peakInPosition = close; // position just opened
    if (isLong && close > peakInPosition) peakInPosition = close;
    wasLong = isLong;

    if (state.warmingUp || ema === null || closes.length <= MOM_SLOW) return [];

    const m60 = close / closes[closes.length - 1 - MOM_FAST]! - 1;
    const m240 = close / closes[closes.length - 1 - MOM_SLOW]! - 1;
    const scoredBar = state.seq - state.warmupBars;

    if (isLong) {
      const value = Number(state.value(symbol, held.qty));
      const exit =
        m60 < EXIT_M60 ||
        close < ema * (1 - EXIT_BAND) ||
        close < peakInPosition * (1 - TRAIL) ||
        value < Number(held.cost) * (1 - HARD) ||
        equity < peakEquity * (1 - DD_BRAKE);
      if (exit) {
        lockoutUntil = scoredBar + LOCKOUT;
        return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: the latch, the halt and the end-of-window guard come first.
    if (halted || scoredBar < lockoutUntil || scoredBar >= LAST_ENTRY_BAR) return [];
    if (equity < initialEquity * HALT_FRACTION) {
      halted = true;
      return [];
    }
    let weight = 0;
    if (m60 > ENTER_M60 && m240 > ENTER_M240 && close > ema * (1 + ENTER_BAND)) {
      weight = WEIGHT;
    } else if (
      !enteredOnce &&
      scoredBar >= FALLBACK_BAR &&
      m60 > FALLBACK_M60 &&
      m240 > FALLBACK_M240 &&
      close > ema * (1 + ENTER_BAND)
    ) {
      weight = FALLBACK_WEIGHT;
    }
    if (weight === 0) return [];

    // Volatility scaler: full size in ordinary tape, trimmed only in a storm.
    const vol = volEmaSq === null ? 0 : Math.sqrt(volEmaSq);
    const scale = Math.min(1, Math.max(VOL_MIN_SCALE, VOL_REF / Math.max(vol, 1e-9)));
    let notional = Math.floor(weight * scale * equity);
    const cash = Number(state.cash);
    if (notional > cash) notional = cash;
    const room = Number(state.weightRoom(symbol));
    if (notional > room) notional = room;
    if (notional <= 0 || BigInt(notional) < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    enteredOnce = true;
    return [{ side: 'buy', symbol, notional_quote_units: BigInt(notional), max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
