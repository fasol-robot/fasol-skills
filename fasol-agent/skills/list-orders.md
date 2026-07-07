# `list_orders` — read open orders on the wallet

> **Sub-skill of [Fasol Agent](../SKILL.md).** Auth, tier (`standard`), and
> the wallet-binding model in parent. For the cleanup pattern that uses
> this endpoint, see [orders-tp-sl](orders-tp-sl.md).

Two endpoints, same response shape. Both require `read_positions`.

```
GET /orders                             — every order on the BOUND wallet, across coins
GET /coin/{coin_address}/orders         — narrowed to one coin
```

> ⏳ The bound-wallet lens ships with the next backend release. Until then
> both endpoints read the account's *active* wallet — an agent bound to a
> different wallet won't see the orders it just placed via `place_order`.
> Post-release, list and create always agree on the wallet.

The response includes **both armed and sleeping orders** so you can see
what's actually queued and what's lurking from past cycles. Sleeping orders
will re-arm on the next buy of their coin — that's exactly the silent
self-sabotage that the cleanup pattern in [orders-tp-sl](orders-tp-sl.md)
exists to prevent.

## Request

```bash
# All orders
curl -s -H "Authorization: Bearer $FASOL_API_KEY" "$FASOL_API_BASE_URL/orders"

# One coin
curl -s -H "Authorization: Bearer $FASOL_API_KEY" \
  "$FASOL_API_BASE_URL/coin/<COIN>/orders"
```

## Response

```json
{
  "data": [
    {
      "id": "ord_abc",
      "type": "take_profit",
      "status": "armed",
      "coin_address": "...",
      "pair_address": "...",
      "symbol": "BONK",
      "trigger_price": "0.0000200",
      "trigger_p": "50",
      "sell_p": "100",
      "bought_sol": "0.1",
      "bought_coin": "8000000",
      "coin_balance": "8000000",
      "source_kind": "agent",
      "source_id": "3",
      "created_at": "...",
      "updated_at": "..."
    }
  ],
  "summary": { "total": 7, "armed": 1, "sleeping": 6 }
}
```

## `status` semantics

| `status` | Meaning |
|---|---|
| `armed` | Watching prices, will fire on next match. `trigger_price` is set. |
| `sleeping` | Relative order (TP / SL / trailing) whose `trigger_price` is empty — fired in a past cycle, OR awaiting a future buy. **Will re-arm on the next buy on this coin.** |

`limit_buy` and `limit_sell` are absolute one-shots — they only appear in
the list while waiting; gone after they fire. They never have `sleeping`
status.

## `source_kind` / `source_id` — whose order is it

| `source_kind` | `source_id` | Owner | Cleanup policy |
|---|---|---|---|
| `"agent"` | your `agent_id` | You | Safe to cancel as part of cycle cleanup. |
| `"agent"` | someone else's | Another agent on this user's account | Leave alone. |
| `"alert"` | `<alert_id>` | Alert autobuy | Touch only if you have the `manage_alerts` scope — the user explicitly granted alert lifecycle. |
| `undefined` | — | User (UI / Telegram bot) | **Never cancel without explicit instruction.** |

This is what lets the agent operate alongside a human user without stomping
on their manually-placed orders.
