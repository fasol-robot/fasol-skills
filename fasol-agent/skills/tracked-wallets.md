# `tracked_wallets` — CRUD over the user's watch list

> **Sub-skill of [Fasol Agent](../SKILL.md).** For the live SSE feed of
> swaps from the watch list, see
> [tracked-wallet-trades](tracked-wallet-trades.md). For grouping them
> into folders, see [wallet-groups](wallet-groups.md).

The agent has full read/write access to the user's tracked-wallets list under
the `manage_tracking` scope. All CRUD mirrors the user-facing UI — the agent
and the UI see the same set in real time. Tier: `standard` (heavy for the
warm-up batch — see below).

## Endpoints

| Method + Path | Purpose |
|---|---|
| `GET /tracked_wallets` | List every tracked wallet for the user |
| `POST /tracked_wallets` | Add wallet(s) — body is an **array**: `[{ wallet, group_id?, name?, emoji? }]` |
| `PUT /tracked_wallets/:wallet` | Update one wallet's `group_id` / `name` / `emoji` |
| `PUT /tracked_wallets/:wallet/notify` | Toggle TG notifications: `{ "notify": true\|false }` |
| `DELETE /tracked_wallets/:wallet` | Untrack one wallet |
| `DELETE /tracked_wallets/all` | Clear the whole tracking list |
| `GET /tracked_wallets/live_trades` | Recent swaps batch — **warm-up only**, see below |

> Both snake_case (`group_id`, `name`) and camelCase (`groupId`, `label`)
> spellings are accepted on POST/PUT; POST also unwraps a
> `{ "wallets": [...] }` envelope. A PUT body with nothing updatable returns
> a structured `400 nothing_to_update` (404 from PUT now genuinely means
> the wallet isn't tracked).

## Examples

```bash
# Add two devs, second one straight into group 4464
curl -s -X POST -H "Authorization: Bearer $FASOL_API_KEY" -H "Content-Type: application/json" \
  -d '[{"wallet":"Cs7c...","name":"BONK dev"},{"wallet":"3fDu...","group_id":4464}]' \
  "$FASOL_API_BASE_URL/tracked_wallets"

# Move an already-tracked wallet into a group (group ids — see wallet-groups.md)
curl -s -X PUT -H "Authorization: Bearer $FASOL_API_KEY" -H "Content-Type: application/json" \
  -d '{"group_id":4464}' \
  "$FASOL_API_BASE_URL/tracked_wallets/Cs7c..."

# Remove from any group
curl -s -X PUT -H "Authorization: Bearer $FASOL_API_KEY" -H "Content-Type: application/json" \
  -d '{"group_id":null}' \
  "$FASOL_API_BASE_URL/tracked_wallets/Cs7c..."

# List
curl -s -H "Authorization: Bearer $FASOL_API_KEY" "$FASOL_API_BASE_URL/tracked_wallets"

# Untrack one
curl -s -X DELETE -H "Authorization: Bearer $FASOL_API_KEY" \
  "$FASOL_API_BASE_URL/tracked_wallets/Cs7c..."
```

## ⚠️ `GET /tracked_wallets/live_trades` is a one-shot warm-up

One call kicks off a parallel `db.trade` (1d) + `db.swap_w` (2h) ClickHouse
replay, rebuilds per-(wallet, coin) trade state, enriches with coin stats
+ Redis SOL balances, and returns the last ~50 swaps. It's the **heaviest
read** in the public surface and is rate-limited at the **heavy** tier
(5 rpm).

Use it **once on startup** to backfill your local view of "what did each
tracked wallet just do" — then switch to the
[`tracked_wallet_trade_stream`](tracked-wallet-trades.md) SSE feed for
everything live.

Polling it every few seconds will:
- (a) burn your heavy-tier quota in seconds,
- (b) cost the backend ~1s of ClickHouse time per call.

Don't.

## Historical performance of a tracked wallet's buys

The live feed and `live_trades` batch only cover *recent* activity. For
"how did the coins this wallet bought actually perform" — per-coin PnL,
win-rate, entry prices over 1d–90d — use
[wallet-trades](wallet-trades.md) (`GET /wallet/{wallet}/trades`,
⏳ next release): one backfill call per wallet, then keep counting
incrementally from the SSE stream.

## Pattern — bootstrap + stream

```js
// 1. Warm up local state
const batch = await api("GET", "/tracked_wallets/live_trades");
for (const swap of batch.data) localState.upsert(swap);

// 2. Subscribe to live (see tracked-wallet-trades.md)
for await (const evt of subscribeTrackedWalletTradeStream()) {
  if (evt.event !== "tracked_trade") continue;
  // skip events you already saw in the warm-up batch — dedup by (wallet, coin, last_tx_at)
  if (localState.alreadySeen(evt.data.trade)) continue;
  // ...react
}
```
