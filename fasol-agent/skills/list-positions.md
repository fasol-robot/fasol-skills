# `list_positions` — open positions on the bound wallet

> **Sub-skill of [Fasol Agent](../SKILL.md).**

`GET /positions` — returns the agent's bound-wallet open positions. The wallet
is derived server-side from the API key; you don't pass it. The response
echoes which wallet was read in a top-level `wallet` field.

> ⏳ Release 2026-07-09: ✅ dev (2026-07-09, verified end-to-end); prod: rolling out from 2026-07-09, status flips to ✅ after the 2026-07-10 verification. Until prod lands the server
> reads the account's *active* wallet — positions may not match what
> `/swap` / `/orders` trade on for multi-wallet owners.

Requires `read_positions`. Tier: `medium`.

## Request

```bash
curl -s -H "Authorization: Bearer $FASOL_API_KEY" "$FASOL_API_BASE_URL/positions"
```

## Response

```json
{
  "data": [
    {
      "coin_address": "...",
      "symbol": "BONK",
      "amount_coin": "1234567.89",
      "value_usd": "234.57",
      "value_sol": "1.23456",
      "avg_buy_price_usd": "0.0000123",
      "current_price_usd": "0.0000234",
      "unrealised_pnl_sol": "0.567",
      "unrealised_pnl_p":   "45.8"
    }
  ],
  "wallet": "Cs7c..."
}
```

A position is "open" iff `amount_coin > 0`. Realised PnL (from past closes)
lives in [`list_trades`](list-trades.md), not here.

## When to use

- Sanity check before opening more cycles (don't double-down on positions you
  forgot about).
- Compute total exposure in SOL for sizing limits.
- Detect positions a strategy lost track of after a restart — reconcile with
  the local "I'm tracking these coins" Map.

For the **history** of how those positions got there, query
[`list_trades`](list-trades.md) with a `from_ts` covering the run.
