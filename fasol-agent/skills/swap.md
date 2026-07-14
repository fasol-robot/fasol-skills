# `swap` — instant market buy / sell

> **Sub-skill of [Fasol Agent](../SKILL.md).** Auth (`fsl_live_…`), rate-limit
> tiers (`medium`), and the wallet-binding model are described in the parent.
> This page covers `POST /swap` end-to-end.

`POST /swap` — fires a swap **NOW** at the current on-chain price on the
agent's bound wallet. The orders engine (`POST /orders`) is trigger-based and
can't satisfy "buy NOW" — use `swap` for instant entry / exit, kill switches,
and copy-trade mirroring. Requires the `place_orders` scope.

## Body shapes

```json
// Instant buy
{ "direction": "buy",  "coin_address": "...", "amount_sol": "0.1" }

// Instant sell — sell_p is % of current position (1..100)
{ "direction": "sell", "coin_address": "...", "sell_p": "100" }

// Optional on either: slippage_p — 0..100, max slippage tolerated.
// Default: the user's saved b_slip / s_slip from settings.
{ "direction": "buy", "coin_address": "...", "amount_sol": "0.1", "slippage_p": "1.5" }
```

```bash
curl -s -X POST \
  -H "Authorization: Bearer $FASOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"direction":"buy","coin_address":"<COIN>","amount_sol":"0.1"}' \
  "$FASOL_API_BASE_URL/swap"
```

## Async response (default — fire-and-forget)

```json
{
  "data": {
    "ok": true,
    "direction": "buy",
    "coin_address": "...",
    "pair_address": "...",
    "note": "tx submitted; subscribe to /agent_stream/tx for fill confirmation, or call again with ?wait=true for synchronous result"
  }
}
```

The tx is published to fasol_core for chain submission. To learn the actual
fill price, slippage, and tx hash, three options in increasing order of
complexity:

1. **`?wait=true`** — make `/swap` synchronous (below). Simplest.
2. **[`tx_stream`](tx-stream.md) SSE** — sub-second `pending` → `success`/`failed`
   events. Best for active strategies that fire many swaps.
3. **[`list_trades`](list-trades.md) polling** — cheapest. Wait a few seconds,
   then `GET /trades?since=…` returns the row from `sol.tb_tx`.

Swaps appear in `list_trades` with `tx_type: "agent_swap"`, so they're
distinguishable from order-fired trades and UI trades.

## Synchronous wait — `POST /swap?wait=true`

Adds `?wait=true` (or `wait_ms=20000` for a custom timeout). The handler holds
the HTTP connection open until fasol_core publishes the matching terminal
event, then returns it. **Default 30s, max 60s.** Use this when you want a
single round-trip "buy and tell me what happened" without managing SSE.

```bash
curl -s -X POST -H "Authorization: Bearer $FASOL_API_KEY" -H "Content-Type: application/json" \
  -d '{"direction":"buy","coin_address":"<COIN>","amount_sol":"0.1"}' \
  "$FASOL_API_BASE_URL/swap?wait=true"
```

**Success — HTTP 200:**

```jsonc
{
  "data": {
    "ok": true,
    "status": "success",
    "commitment": "processed",        // sometimes "confirmed" if it landed there first
    "hash": "5Qw...abc",
    "direction": "buy",
    "coin_address": "...",
    "pair_address": "...",
    "amount_sol": "0.10",
    "amount_coin": "1234567",
    "price_usd": "0.00001234",
    "error_text": null
  }
}
```

**Tx-failed — HTTP 502:**

```jsonc
{
  "data": {
    "ok": false,
    "status": "failed",
    "commitment": "processed",
    "hash": "5Qw...abc",
    "error_text": "slip"
  }
}
```

**Timeout — HTTP 504:** the tx may still confirm seconds later. After 504
the agent should `GET /trades?coin_address=…&since=<just before submit>`
once or twice to find the result, or open `tx_stream` and wait. 504 ≠ failure.

## 400 responses carry self-correction hints (2026-05-29)

Every 400 from this endpoint includes structured fields so you can fix the
body without guessing. Read them in order: `missing` / `invalid` →
`example` → `docs`.

```jsonc
// 400 example: agent forgot amount_sol on a buy
{
  "error": "buy_requires_positive_amount_sol",
  "message": "For direction=\"buy\" body must include \"amount_sol\" as a positive numeric string (whole SOL, not lamports).",
  "missing": ["amount_sol"],
  "got": { "amount_sol": null },
  "example": { "direction": "buy", "coin_address": "<base58 mint>", "amount_sol": "0.1" },
  "docs": "https://github.com/fasol-robot/fasol-skills/blob/main/fasol-agent/skills/swap.md"
}
```

**Workflow on 400:** copy `example`, fill in your real values, retry once.
If the second attempt also 400s, stop and surface the error to the user —
don't loop.

## Error codes worth knowing

| HTTP | `error_text` | What it means |
|---|---|---|
| 400 | `invalid_body` | Missing `direction` / `coin_address` / `amount_sol`-or-`sell_p`. |
| 400 | `bad_amount` | Amount ≤ 0 or non-numeric. |
| 412 | `agent_wallet_unset` | Owner hasn't picked a wallet for this agent yet — tell them. |
| 412 | `agent_wallet_invalid` | Wallet was deleted; owner needs to pick a fresh one. |
| 429 | `rate_limit_exceeded` | Honour `Retry-After`. |
| 502 | `slip` | Slippage exceeded `slippage_p`. Retry with higher tolerance or re-quote. |
| 502 | `insufficient_funds` | Not enough SOL on the wallet (incl. fees + bot_fee). |

## Cost reminder

Per-cycle fees on `/swap` ≈ **0.0006 SOL** (gas + fasol_fee). At 0.001 SOL
trade size that's 60% of the trade. Don't trade below 0.005 SOL unless you're
doing dust cleanup — the math doesn't work.

**Agent cashback.** Every trade through the agent API — `/swap` AND the fills
of agent-placed limit / TP / SL / trailing orders — earns **80% of the fasol
platform fee back** as claimable rewards (credited by a background worker to
the account's reward balance, shown on the web `/rewards` page, withdrawn
there by the owner). So the effective platform fee on agent trading is ~1/5
of the sticker fee. Automatic on any tx tagged to your key — nothing to pass.
(Global rate set by the platform; here for cost-model awareness, not a knob
you configure.)
