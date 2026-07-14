# Fasol Skill — Sub-skills directory

This directory holds **focused sub-skills**, each describing one capability of
the Fasol Agent API in detail. The top-level [`SKILL.md`](../SKILL.md) is the
shared context (auth, rate limits, common pitfalls). Sub-skills are loaded on
demand — when the agent needs to do something specific, it reads the matching
file from `skills/` instead of carrying the whole monolith in context.

> **Programmatic discovery:** [`skills.json`](../skills.json) in the parent
> directory holds the same catalog as machine-readable JSON. Use it when the
> agent runtime supports search ("find a skill that does X"); use this file
> when a human is reading.

## How to use

1. Read [`../SKILL.md`](../SKILL.md) **first** — it covers auth (`fsl_live_…`),
   rate-limit tiers, wallet binding, the "API key vs. web API" distinction, and
   safety rules. Every sub-skill assumes that context.
2. Skim [`changelog.md`](changelog.md) — last 10 changes to API or skill text.
   If a sub-skill was changed in the last week, read its full file instead of
   relying on memory.
3. Pick the sub-skill matching the user's request from the catalog below.
4. Read **only** that sub-skill's file. Don't preload others "just in case" —
   that's exactly what this split is meant to avoid.

## Catalog

All sub-skills below are extracted and self-contained. The parent SKILL.md
keeps shared context (auth, tiers, wallet binding) and a brief overview;
detail lives here.

### trading

| Slug | What it does |
|---|---|
| [`swap.md`](swap.md) | `POST /swap` — instant buy / sell with optional `?wait=true` synchronous confirmation. |
| [`place-order.md`](place-order.md) | `POST /orders` — limit buy / limit sell / take_profit / stop_loss / trailing. |
| [`cancel-order.md`](cancel-order.md) | `DELETE /orders/:id` — cancel a specific pending order. |
| [`list-orders.md`](list-orders.md) | `GET /orders` and `GET /coin/:ca/orders` — read open + sleeping orders. |
| [`orders-tp-sl.md`](orders-tp-sl.md) | Lifecycle: TP/SL/trailing persist past their fire and re-arm on the next buy. Cycle cleanup pattern. |

### data & stats

| Slug | What it does |
|---|---|
| [`coin-stats.md`](coin-stats.md) | `GET /coin/:ca/stats` — current state of a coin (price, MC, liq, holders, dev hold, etc.). |
| [`candles.md`](candles.md) | OHLC: historical (`/candles`) + last 5 min (`/candles_fast`). |
| [`snapshot-history.md`](snapshot-history.md) | `GET /snapshot/coin/:ca/history` — time-series for one coin. |
| [`snapshot-agg.md`](snapshot-agg.md) | `GET /snapshot/coin/:ca/agg` — min/max/count over a window. |
| [`snapshot-first-match.md`](snapshot-first-match.md) | `POST /snapshot/coin/:ca/first_match` — when condition first/last held. |
| [`snapshot-scan.md`](snapshot-scan.md) | `POST /snapshot/scan` — cross-coin discovery at a moment in time. |

### live streams (SSE)

| Slug | What it does |
|---|---|
| [`coin-price-stream.md`](coin-price-stream.md) | `GET /agent_stream/coin/:ca` — live price ticks. |
| [`coin-trade-stream.md`](coin-trade-stream.md) | `GET /agent_stream/coin/:ca/trades` — every swap on one coin. |
| [`tx-stream.md`](tx-stream.md) | `GET /agent_stream/tx` — confirmation events for the bound wallet's swaps. |
| [`tracked-wallet-trades.md`](tracked-wallet-trades.md) | `GET /agent_stream/tracked_wallet_trades` — live SSE of swaps from tracked wallets. |
| [`smart-money-stream.md`](smart-money-stream.md) | `GET /agent_stream/smart_money_trades` — global SM-cohort swaps; optional `?wallets=` filter. |
| [`calls-stream.md`](calls-stream.md) | `GET /agent_stream/calls` — caller publications from followed callers. |
| [`alert-match-stream.md`](alert-match-stream.md) | `GET /agent_stream/alert_matches` — live alert firings + milestones. |

### analytics & discovery

| Slug | What it does |
|---|---|
| [`alert-simulate.md`](alert-simulate.md) | `POST /alert/simulate` — replay an alert filter against last 1-5 days of `db.coin_snapshot`. |
| [`wallet-search.md`](wallet-search.md) | `POST /wallet_search` — discover wallets by profit / activity / behaviour. |
| [`wallet-trades.md`](wallet-trades.md) | `GET /wallet/{wallet}/trades` — per-coin PnL performance of any wallet's buys. |
| [`deployer.md`](deployer.md) | `GET /dev/:deployer` — full history of a deployer's launches. |

### alerts (read + write)

| Slug | What it does |
|---|---|
| [`alerts-read.md`](alerts-read.md) | List, per-alert stats, triggered history. |
| [`alerts-write.md`](alerts-write.md) | Create / update / pause / autobuy. |

### tracking

| Slug | What it does |
|---|---|
| [`tracked-wallets.md`](tracked-wallets.md) | CRUD over the user's tracked wallets list + warm-up batch. |
| [`wallet-groups.md`](wallet-groups.md) | Manage folders (groups) for tracked wallets. |

### positions & identity

| Slug | What it does |
|---|---|
| [`get-scope.md`](get-scope.md) | `GET /scope` — agent identity, scopes, bound wallet. Always allowed. |
| [`list-positions.md`](list-positions.md) | `GET /positions` — open positions on the bound wallet. |
| [`list-trades.md`](list-trades.md) | `GET /trades` — realised trade history. Source of truth for PnL. |
| [`wallet-balance.md`](wallet-balance.md) | `GET /wallet_balance` — bound-wallet SOL balance. |

## Reading order — first-time agent

1. [`../SKILL.md`](../SKILL.md) — shared context (auth, tiers, wallet binding, safety).
2. [`changelog.md`](changelog.md) — what's recently changed.
3. [`get-scope.md`](get-scope.md) — confirm what your key can do.
4. The sub-skill matching the user's request — for example
   [`swap.md`](swap.md) for "buy this token" or
   [`tracked-wallet-trades.md`](tracked-wallet-trades.md) for "build me a
   copy-trader."
