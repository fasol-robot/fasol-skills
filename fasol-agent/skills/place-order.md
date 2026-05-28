# `place_order` — limit / TP / SL / trailing orders

> **Sub-skill of [Fasol Agent](../SKILL.md).** Auth (`fsl_live_…`), rate-limit
> tier (`standard`), and the wallet-binding model in parent. For the cycle
> cleanup pattern that TP/SL/trailing orders require, see
> [orders-tp-sl](orders-tp-sl.md). For cancelling, see [cancel-order](cancel-order.md).

`POST /orders` — create a **trigger-based** order that the orders engine
watches and fires when the price condition is met. Use this for limit entries
and TP / SL / trailing exits. For instant entry / exit use [`swap`](swap.md)
instead — the orders engine cannot satisfy "buy NOW".

Requires the `place_orders` scope.

## Body — `type` selects the variant

```json
// Absolute price entry
{ "type": "limit_buy",  "coin_address": "...", "trigger_price": "0.00001234", "amount_sol": "0.1" }
{ "type": "limit_sell", "coin_address": "...", "trigger_price": "0.00002000", "sell_p": "100" }

// Percent-relative exits — recomputed against the actual entry price after the buy fills
{ "type": "take_profit", "coin_address": "...", "trigger_p": "50",  "sell_p": "100" }
{ "type": "stop_loss",   "coin_address": "...", "trigger_p": "-25", "sell_p": "100" }

// Trailing — activates after price moves activation_p% from entry, sells on trailing_p% pullback from peak
{ "type": "trailing", "coin_address": "...", "trailing_p": "10", "sell_p": "100", "activation_p": "0" }
```

> ⚠️ **TP / SL / trailing persist past their fire and re-arm on the next buy
> of the same coin.** If you `POST /orders` a TP every cycle without cleaning
> up the previous one, duplicates stack and all activate on the next entry —
> the first to fire wins, often closing your position immediately. See
> [orders-tp-sl](orders-tp-sl.md) for the full lifecycle + cleanup pattern.

## Request

```bash
curl -s -X POST \
  -H "Authorization: Bearer $FASOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"type":"take_profit","coin_address":"...","trigger_p":"50","sell_p":"100"}' \
  "$FASOL_API_BASE_URL/orders"
```

## Response

```json
{
  "data": {
    "id": "ord_abc123",
    "type": "take_profit",
    "status": "pending"
  }
}
```

`status: "pending"` = order accepted but not yet armed (waiting for entry to
fill, or waiting for price). After fill / trigger you'll see the updated
state via [`list_orders`](list-orders.md) and the actual fill via
[`list_trades`](list-trades.md).

## 400 responses carry self-correction hints (2026-05-29)

Every 400 from this endpoint includes structured fields so you can fix the
body without guessing. Read them in order: `missing` / `invalid` →
`allowed` → `example` → `docs`.

```jsonc
// 400 example: agent placed a take_profit without trigger_p
{
  "error": "take_profit_requires_trigger_p_and_sell_p",
  "message": "For type=\"take_profit\" body must include \"trigger_p\" (percent from entry; negative for stop_loss) and \"sell_p\" (% of position).",
  "missing": ["trigger_p"],
  "got": { "trigger_p": null, "sell_p": "100" },
  "example": { "type": "take_profit", "coin_address": "<base58 mint>", "trigger_p": "50", "sell_p": "100" },
  "docs": "https://github.com/fasol-robot/fasol-skills/blob/main/fasol-agent/skills/place-order.md"
}
```

If `type` is unrecognised, the response includes an `allowed` field listing
the five valid order types: `limit_buy`, `limit_sell`, `take_profit`,
`stop_loss`, `trailing`.

**Workflow on 400:** copy `example`, fill in your real values, retry once.
If the second attempt also 400s, stop and surface the error to the user.

## Trigger semantics

| Order side | Fires when |
|---|---|
| Buy (`limit_buy`, relative buy) | `price <= trigger_price` |
| Sell (`limit_sell`, TP, SL, trailing) | `price >= trigger_price` (TP / limit_sell), `price <= trigger_price` (SL) |

A `limit_sell` with `trigger_price: "0"` will **never** fire — the price
never gets to zero. Use [`swap`](swap.md) with `direction: "sell"` for instant
exits.

## `source_kind` and `source_id`

Every order you place via the agent surface is tagged
`source_kind: "agent"` + `source_id: <your_agent_id>`. Use those fields when
listing orders to recognise yours vs. orders the user placed in the UI or
that came from an alert autobuy. See [list-orders](list-orders.md) for the
full guidance.
