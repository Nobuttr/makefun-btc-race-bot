[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/Nobuttr/makefun-btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/Nobuttr/makefun-btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

# Harbor Impulse-Latch — a cbBTC/USDC minute-bar racing bot

Entry for make.fun's **btc-race-24h-20261118-1444** ("Race a BTC trading bot live
for 24 hours"). The bot trades Coinbase Wrapped BTC (cbBTC) against USDC, one
1-minute bar at a time, under the `agent-fun/bars-replay/v1` protocol: $1,000 of
paper money, fills at the next bar's open, 4 bps fee + 2 bps slippage + pool
price impact on every trade. Nothing is traded for real.

## The strategy

A long-only trend system built around one observation: at this size a round
trip costs roughly 25–35 bps all-in (fees, slippage, and impact against a ~$1M
pool), while per-minute volatility is only ~0.07%. Bots that react to every
1-minute wiggle donate that spread to the pool — on the published dev window
(a −2.8% day) the kit's fast reference bots lose between 2% and 15%. So this
bot stays in cash unless the market proves a real impulse, takes that impulse
at near-full weight, and then goes silent for hours.

**Entry** (flat, latch open) — all three on the same close:

- 60-bar momentum above **+0.40%** (an impulse, not noise),
- 240-bar momentum above **+0.40%** (the impulse agrees with the 4-hour trend;
  a one-hour bounce inside a downtrend never triggers it),
- close above the 240-bar EMA by **+0.10%** (price has reclaimed its trend line).

Size is 97% of equity, trimmed by a volatility scaler only in extreme tape
(per-minute realised vol above ~0.09%: size scales down toward a 0.55× floor).

**Exit** — the first of: 60-bar momentum below −0.25%; close back under the
240-bar EMA by 0.10%; a 1.6% trailing stop under the highest close since
entry; a 3% hard stop under cost; or equity 6% under its peak. After any exit
the **latch** stays shut for 480 bars (8 hours) — the hours after a trend leg
are when lagging signals re-fire into chop and bleed fees.

**Fallback:** the race guardrails ask for at least one trade, so if no entry
has fired by bar 1000 the gate relaxes (momentum +0.25% / +0.10%, half weight)
and a quiet day still produces one careful trade. No entries in the last 15
bars, and entries stop for the run if equity falls under 85% of the start
(the race's drawdown guardrail is 25%; this keeps a bad day far from it).

## Dev-window result

Graded with the kit's own `grade-local` on the published dev window:

| | |
|---|---|
| Net PnL | **+10.16 USDC (+1.02%)** |
| Trades | 2 (one round trip) |
| Max drawdown | 0.62% |
| Fees paid | 0.78 USDC |
| Net PnL at 2× fees | +9.38 USDC |

For reference, every house baseline loses money on the same window
(buy-and-hold −31.63, momentum −23.87, RSI-Bollinger −39.92, EMA-cross −148.17).

## Layout

- `main.ts` — the bot (strategy + protocol loop via the vendored SDK).
- `vendor/makefun-bars.ts` — the kit's bars-replay SDK, vendored byte-identical
  as the kit prescribes.
- `LICENSE` — MIT.

## Determinism

Decisions use only `+ − * /`, `Math.sqrt/min/max` on float64 and the bars
themselves — no clock, no randomness, no environment, no files — so two runs
over the same window produce byte-identical orders (the grader's two
executions of this entry match exactly).
