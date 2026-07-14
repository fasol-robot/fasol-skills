# `get_scope` — what this API key is allowed to do

> **Sub-skill of [Fasol Agent](../SKILL.md).**

`GET /scope` — returns the agent's identity, the granted scopes, and which
"tool names" the runtime should expose to the LLM. Always allowed (no scope
required). Tier: `standard`.

> **Always call this first.** Knowing your scopes lets you avoid attempting
> calls that would 403, and the runtime's tool list should be the scope
> intersection with what's actually available. The `data.wallet` field also
> tells you which wallet your trades will fire on — your "self" identifier.
> Reads (`/positions`, `/orders`, `/trades`, `/wallet_balance`) default to
> this same wallet (since release 2026-07-09), so you
> normally never need to filter by wallet yourself.

## Request

```bash
curl -s -H "Authorization: Bearer $FASOL_API_KEY" "$FASOL_API_BASE_URL/scope"
```

## Response

```json
{
  "data": {
    "agent_id": 3,
    "agent_name": "my claude",
    "wallet": "Cs7c...",
    "scopes": ["read_coins", "read_positions", "place_orders"],
    "scope_delivery": "runtime",
    "allowed_tools": ["coin_stats", "list_positions", "place_order"]
  }
}
```

## 412 — wallet not set

If `GET /scope` returns **`412 Precondition Failed`** with
`{ "error": "agent_wallet_unset" }`, your owner has not picked a wallet for
this agent yet. Tell them:

> "I need a wallet bound to this key before I can do anything. Open the AI
> Agents UI and pick a wallet for me."

Don't retry — 412 won't recover until the owner acts.

`{ "error": "agent_wallet_invalid" }` means the wallet was deleted or no
longer belongs to the user. Same response: ask them to pick a fresh wallet.

## Scope reference

| Scope | Lets you call |
|---|---|
| `read_coins` | `coin_stats`, snapshot tools, candles, price/trade streams |
| `read_positions` | `list_positions`, `list_orders`, `list_trades`, `wallet_balance`, tx_stream |
| `read_dev_history` | [`dev_history`](deployer.md) |
| `read_alerts` | alerts read endpoints, alert backtest, alert_match_stream |
| `place_orders` | `swap`, `place_order` |
| `cancel_orders` | `cancel_order` |
| `manage_alerts` | alerts write endpoints, alerts CRUD |
| `manage_tracking` | tracked-wallets CRUD, tracked-wallet trade stream |
