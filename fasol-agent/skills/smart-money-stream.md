# `smart_money_trade_stream` — live SSE of curated Smart Money cohort

> **Sub-skill of [Fasol Agent](../SKILL.md).** For per-user tracked wallets
> see [tracked-wallet-trades](tracked-wallet-trades.md). For per-coin trade
> flow see [coin-trade-stream](coin-trade-stream.md).

`GET /agent_stream/smart_money_trades` — live Server-Sent-Events feed of
**every swap** by any wallet in Fasol's curated Smart Money cohort
(maintained in `fadev.sol.smart_money_wallet`). Same payload shape the UI's
Smart Money page consumes. **Stream is global** — every connected agent
receives every SM swap, no per-user filtering on the server.

Requires `read_wallets` (default-on). Tier: `sse` (concurrent-connection-capped,
not rpm).

---

## Request

```bash
curl -N -H "Authorization: Bearer $FASOL_API_KEY" \
  "https://api.fasol.trade/agent_stream/smart_money_trades"
```

> ⚠️ Agent stream endpoints live under `/agent_stream/...`, NOT under
> `/trading_bot/agent/...`. Same Bearer token, different URL tree.

### Optional `?wallets=` filter

To narrow the stream server-side to a subset of SM wallets, pass a
comma-separated allow-list of base58 mints. Limit: **50 wallets**.

```bash
curl -N -H "Authorization: Bearer $FASOL_API_KEY" \
  "https://api.fasol.trade/agent_stream/smart_money_trades?wallets=Cs7c...,3fDu...,9XKp..."
```

The server checks each wallet for base58 validity and rejects with `400` on
empty filter, > 50 entries, or invalid wallet. With no `wallets=` parameter,
the agent receives the full cohort firehose.

## Wire format

```
event: ready
data: {
  "agent_id": 3,
  "wallet_filter": null,                 // or ["Cs7c...", "3fDu..."] when ?wallets= passed
  "server_time": "...",
  "note": "global smart-money trades; heartbeat every 15s"
}

data: {
  "type": "smart_money_trade",
  "trade": {
    "wallet": "Cs7c...",
    "coin_address": "...",
    "buy_sell": "buy",                    // or "sell"
    "amount_sol": 0.42,
    "amount_coin": 1234567,
    "hash": "5Qw...",
    "date": 1745779200123,
    "price_usd": "0.0000123",
    "in_sol": 0.5, "out_sol": 0.0,
    "coin_balance": 1234567,
    "buy_count": 1, "sell_count": 0,
    "first_tx_at": 1745779200123,
    "last_tx_at":  1745779200123,
    "trade_type": "first_buy",            // first_buy / buy_more / sell_part / sell_all / sell_air
    "pnl_sol": 0,
    "pnl_percent": 0,
    "symbol": "BONK",
    "image": "...",
    "mc": "...",
    "pair_version": "pam",
    "coin_created_at": 1745778000000,
    "wallet_label": "smart_degen #12",    // SM cohort label / rank info
    "wallet_emoji": "🦊",
    "group_id": 12,                       // SM cohort rank (lower = higher)
    "wallet_sol_balance": 12.34
  }
}

: heartbeat
```

Heartbeats arrive every 15 seconds. Use them to detect a dead TCP pipe — if
you go > 30 seconds without one, the connection is gone.

### Payload notes

- Same `LiveTrade` shape as [tracked-wallet-trades](tracked-wallet-trades.md);
  `trade_type` semantics are identical (`first_buy` is the strongest entry
  signal, `buy_more` carries cumulative `pnl_percent` since `first_tx_at`).
- `group_id` is the wallet's rank inside the SM cohort (lower = higher
  conviction in our curation). Useful as a client-side filter ("only mirror
  top-50 SM wallets").
- `wallet_label` carries the cohort label / annotation the curator
  attached. Don't parse it — just surface it in dashboards.

## Cost / volume expectations

The SM cohort is curated to a manageable size (≈ hundreds of wallets at any
moment), but during pumpfun-heavy hours the unfiltered firehose can produce
**tens of swaps per minute**. Plan accordingly:

- For sub-second reactions: stream + `?wallets=` filter to your watch-list.
- For passive monitoring: stream unfiltered, do all filtering client-side.
- For "give me the top SM hits of the last hour" — don't poll this; use
  [snapshot-scan](snapshot-scan.md) or [wallet-search](wallet-search.md).

## When to use vs. tracked-wallet-trades

| Pattern | Use |
|---|---|
| Mirror specific wallets the user added to their tracking list | [tracked-wallet-trades](tracked-wallet-trades.md) |
| React to the platform's whole Smart Money cohort | `smart_money_trade_stream` (this) |
| React to a subset of SM wallets (e.g. top 20 by rank) | this + `?wallets=` filter |

## Worked example — mirror top-N SM by rank

```js
const TOP_N_RANK = 20;
const COPY_RATIO = 0.05;  // 5% of their size

const url = `${STREAM_BASE}/smart_money_trades`;
for await (const evt of streamSSE(url)) {
  if (evt.event !== "ready" && evt.event !== "message") continue;
  if (evt.data?.type !== "smart_money_trade") continue;
  const t = evt.data.trade;

  if (t.group_id == null || t.group_id > TOP_N_RANK) continue;  // outside top-N
  if (t.buy_sell !== "buy" || t.trade_type !== "first_buy") continue;  // only first buys

  const amount_sol = (t.amount_sol * COPY_RATIO).toFixed(4);
  await api("POST", "/swap", {
    body: { direction: "buy", coin_address: t.coin_address, amount_sol },
  });
}
```

## Failure modes

Same as other streams (auto-reconnect with backoff inside `streamSSE`,
terminal on 401/403/404). No per-user JOIN/LEAVE state — the SM cohort
cache lives globally in REDIS_STAT, your reconnect just re-attaches to the
same in-process subscription.
