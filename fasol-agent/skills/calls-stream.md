# `calls_stream` — live SSE of followed callers' publications

> **Sub-skill of [Fasol Agent](../SKILL.md).** For alert-driven signals see
> [alert-match-stream](alert-match-stream.md). For Smart Money cohort swaps
> see [smart-money-stream](smart-money-stream.md).

`GET /agent_stream/calls` — live Server-Sent-Events feed of caller
publications ("calls") from the users your owner follows. Same feed the UI
`/callers` page consumes. **Per-user** — the server filters by the
authenticated user's `tb_user_caller_subscription` rows; agent only sees
calls from caller-accounts its owner explicitly follows.

Requires `read_alerts`. Tier: `sse`.

---

## Request

```bash
curl -N -H "Authorization: Bearer $FASOL_API_KEY" \
  "https://api.fasol.trade/agent_stream/calls"
```

> ⚠️ Agent stream endpoints live under `/agent_stream/...`, NOT under
> `/trading_bot/agent/...`.

## Wire format

Three event types after the initial `ready`:

```
event: ready
data: {
  "user_id": 50772161,
  "agent_id": 3,
  "server_time": "...",
  "note": "caller publications for your followed callers; init batch follows, then new calls + periodic price updates; heartbeat every 15s"
}

event: call_init
data: {
  "items": [<CallRecord>, <CallRecord>, ...]    // up to 30 most-recent calls across followed callers
}

event: call_new
data: {
  "items": [<CallRecord>]                       // newly published call (one or more per event)
}

event: call_prices
data: {
  "prices": {
    "<coin_address>": 0.0000123,
    "<coin_address>": 0.0000234
  }
}

: heartbeat
```

### `CallRecord` shape

```jsonc
{
  "caller_user_id": 123456,
  "caller_username": "alpha_caller",  // null if private
  "coin_address": "...",
  "symbol": "BONK",
  "image": "...",
  "supply": 1000000000,
  "call_price_usd": 0.0000123,        // price at the moment the call was published
  "ath_price_usd": 0.0000281,         // ATH-since-call (server-updated)
  "price_usd": 0.0000156,             // current price snapshot at event time
  "called_at": 1745779200123,         // ms epoch
  "coin_created_at": 1745778000000,
  "coin_ath_mc": 87000,               // null until ATH-after-call is observed
  "version": "pam",
  "comment": null                     // optional caller comment
}
```

Heartbeats arrive every 15 seconds.

### Event sequencing

1. **Right after `event: ready`** the server publishes one `event: call_init`
   with up to 30 most-recent calls across all followed callers. Drop this
   into your local state — it's the backfill for missed events while the
   agent was offline.
2. **`event: call_new`** arrives any time a caller you follow publishes a
   new call. Usually `items.length === 1`. Server-side dedupes within
   `(caller_user_id, coin_address)` so reposts don't duplicate.
3. **`event: call_prices`** is a periodic batch of `{coin_address → current price_usd}`
   updates for coins in your local set, fired roughly every block on
   `FILTERED_BLOCK`. Apply to refresh your view without re-fetching
   `coin_stats`.

## When to use

| Pattern | Use |
|---|---|
| React to a followed caller's new call | `calls_stream` (this) |
| React to alert config matches | [alert-match-stream](alert-match-stream.md) |
| Backfill caller history for a user | call `/callers/leaderboard` + `/callers/:callerId` (REST) |
| Get current price of a coin in an event | the `event: call_prices` payload — don't re-fetch `coin_stats` |

## Worked example — mirror a followed caller's calls

```js
const COPY_SOL = 0.05;
const url = `${STREAM_BASE}/calls`;

const seen = new Set();            // dedup against init batch + reposts
const callsByCoin = new Map();     // coin_address → most-recent call

for await (const evt of streamSSE(url)) {
  if (evt.event === "ready") continue;

  if (evt.event === "call_init") {
    // Backfill — do NOT trade these; just seed dedup state.
    for (const r of evt.data.items) seen.add(`${r.caller_user_id}:${r.coin_address}`);
    continue;
  }

  if (evt.event === "call_new") {
    for (const r of evt.data.items) {
      const key = `${r.caller_user_id}:${r.coin_address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      callsByCoin.set(r.coin_address, r);

      // Sanity-check the coin via coin_stats (liquidity, dev_hold) before entering.
      const stats = await api("GET", `/coin/${r.coin_address}/stats`);
      if (looksGood(stats)) {
        await api("POST", "/swap", {
          body: { direction: "buy", coin_address: r.coin_address, amount_sol: String(COPY_SOL) },
        });
      }
    }
    continue;
  }

  if (evt.event === "call_prices") {
    // Update your local prices map for any caller call you opened a position on.
    for (const [ca, p] of Object.entries(evt.data.prices)) {
      const r = callsByCoin.get(ca);
      if (r) r.price_usd = p;
    }
    continue;
  }
}
```

## Setup prerequisites

The stream is **empty** until the owner follows at least one caller. To
manage the follow list, point the user at `fasol.trade/callers` (UI) or
the `/callers` REST endpoints. The agent can read the current follow list
via `/callers/...` REST but cannot follow/unfollow (no `manage_callers`
scope at the moment).

## Failure modes

- **Empty stream after `ready`** — owner follows zero callers. Tell them.
- **Auth revoked / scope changed** → 401/403 — terminal, helper throws.
- **REDIS_STAT restart** → cache rebuilds from PG + CH on next JOIN; if
  your SSE is reconnecting, `streamSSE` re-fires `CALL_FEED_JOIN` and you
  get a fresh `call_init` batch.

No keepalive needed — `callFeed/service.ts` doesn't TTL-evict
`userCalls` for the agent SSE consumer (we use a symmetric "is anyone
else still listening" check in `roomManager/rooms/callFeed.ts` so neither
the UI socket leaving nor the SSE closing can prematurely drop the cache
while the other side still consumes it).
