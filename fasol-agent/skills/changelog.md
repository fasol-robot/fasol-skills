---
name: changelog
description: Ротируемый журнал последних изменений Fasol Agent API + skill. Агент проверяет его при каждом daily refresh, чтобы не нарваться на изменённое поведение.
metadata:
  type: reference
---

# Fasol Skill — Changelog

Этот файл — **источник правды о том, что недавно менялось** в Fasol Agent API,
в схеме `skills.json` или в самом тексте `SKILL.md`. Цель — чтобы любой агент
при ежедневном refresh (по инструкции в [Keeping this skill up to date](../SKILL.md#keeping-this-skill-up-to-date))
прочитал верх этого файла за 30 секунд и узнал, что поменялось в его поведении
с прошлого запуска.

**Ротация: оставляем последние 10 записей.** Когда добавляется новая, самая
старая удаляется. Это _не_ git-история — для полной хронологии есть
[`git log fasol-agent/`](https://github.com/fasol-robot/fasol-skills/commits/main/fasol-agent).

**Формат каждой записи:**

```
## YYYY-MM-DD — <короткий заголовок>

**Где:** какая ручка / sub-skill / общий раздел затронут
**Что изменилось:** одно-два предложения, какое поведение поменялось.
**Что делать агенту:** 1-3 буллета — нужно ли что-то поменять в своём коде,
обновить кэш, перестроить опоры на старое поведение.
```

---

## 2026-07-08 — `autobuy_orders`: doc example was WRONG (`type` key + numeric values)

**Where:** [alerts-write](alerts-write.md) — `POST /alerts`, `PUT /alert/:id`,
`POST /alert/:id/autobuy`.

The documented `autobuy_orders` example showed a `type` field
(`"type": "take_profit"`) and bare JSON numbers. Both are wrong. The real
schema has **no `type` key** — TP vs SL is derived from the **sign** of
`trigger_p`, trailing from the presence of `trailing_p` — and all values
are **strings**:

```json
[
  { "trigger_p": "50",  "sell_p": "100" },
  { "trigger_p": "-25", "sell_p": "100" },
  { "trailing_p": "10", "sell_p": "100", "activation_p": "0" }
]
```

The server currently stores whatever you send: with `type` / numbers the
buy and the armed orders still execute, but the owner's web UI crashes
rendering that alert's Autobuy settings and offers to DELETE the alert.

**What to do:**

- Send `autobuy_orders` values as **strings**, never numbers; no `type` key —
  encode SL as a negative `trigger_p`.
- If you created alerts with the old doc format, re-send
  `POST /alert/:id/autobuy` with corrected string values to repair them.

**Roll-out:** doc fix only — this is the format the backend and web UI have
always expected.

---

## 2026-07-04 — SSE slots: phantom connections no longer block reconnects

**Where:** every `GET /agent_stream/*` endpoint + `GET /rate_limit`
(`sse_connections.active`).

Dirty TCP resets (e.g. `InvalidChunkLength` drops) could leave a dead
connection counted as active for 15–30 minutes: the per-agent slot hash had
one shared TTL that every LIVE connection's heartbeat kept refreshing, so
phantom entries never aged out while you had any stream up. A chain of
resets accumulated to `active:5` and new connects bounced with
`429 sse_concurrent_limit` for minutes — a blind window with zero real
connections held.

Fixed server-side:

- Each connection now refreshes its OWN last-seen mark on every 15s
  heartbeat; entries silent for >45s (3 missed heartbeats) are stale.
- On connect, if the slot count looks full, stale entries are pruned first
  and the connect is accepted — **a reconnect now clears its dead
  predecessors itself** instead of being blocked by them.
- `GET /rate_limit` prunes the same way before reporting, so
  `sse_connections.active` reflects live streams only.

**What to do:** nothing — keep your auto-reconnect + backoff on 429. After
this ships, a 429 `sse_concurrent_limit` means you genuinely hold 5 live
streams. Phantom lifetime is now ≤ ~60s worst-case instead of 15–30 min,
and the reconnect path self-heals immediately.

**Roll-out:** ⏳ ships with the next backend release.

---

## 2026-07-02 — autobuy fires from the agent's own wallet by default

**Where:** `POST /alert/{id}/autobuy` and the `POST /alerts` / `PUT /alert/{id}`
upsert. Sub-skill: [alerts-write](alerts-write.md).

Setting autobuy through an agent key now binds the execution wallet to **that
agent's bound wallet** when you don't pass an explicit `ab_wallet` — same
parity as `/swap` and `/orders`. Previously the autobuy silently fell back to
the account's *active* wallet, so a multi-wallet owner who set autobuy via the
agent-for-wallet-X saw buys fire from their primary wallet instead of X.

**What to do:**

- Nothing, if you want autobuy on the agent's own wallet — it just works now.
- Pass `ab_wallet` explicitly only to fire autobuy from a *different* owned
  wallet than the agent's.

**Roll-out:** ⏳ ships with the next backend release (dev first).

*Unrelated account note (not an API change): the active-agents-per-user cap
was raised 3 → 10. If `POST /agents` returns `409 max N active agents`, that's
the cap — revoke an unused agent or ask the owner. A 409 means no key was
issued; don't treat the response as a working key.*

---

## 2026-06-12 — `tracked_wallets`: `group_id` / `name` now accepted on POST + PUT

**Where:** `POST /tracked_wallets`, `PUT /tracked_wallets/:wallet`.
Sub-skill: [tracked-wallets](tracked-wallets.md).

The shared backend handlers silently expected camelCase `groupId` / `label`,
while GET responses (and this skill) use snake_case `group_id` / `name`.
Agents echoing the documented dialect hit two bugs:

- `POST` stored every wallet with `group_id: null` (field silently dropped)
- `PUT` with only `group_id` ran an empty update and replied
  `404 "Wallet not found"` for wallets that exist

Fixed on the agent surface: both spellings are accepted (`group_id`/`groupId`,
`name`/`label`), `POST` also unwraps the `{ "wallets": [...] }` envelope, and
a `PUT` body with nothing updatable now returns a structured
`400 nothing_to_update` (with `example` + `docs`) instead of the misleading
404. Notifications toggle stays on its own endpoint:
`PUT /tracked_wallets/:wallet/notify` with `{ "notify": true|false }`.

**What to do:**

- Keep sending snake_case — it will simply start working.
- If you implemented the `groupId` workaround, you can leave it; both work.
- Treat `404` from PUT as "wallet really isn't tracked" again (after the
  release), and `400 nothing_to_update` as "my body had no updatable fields".

**Roll-out:** ✅ prod (2026-06-12 release).

---

## 2026-06-11 — `alerts_write`: server now VALIDATES alert format (structured 400s)

**Where:** `POST /alerts` and `PUT /alert/{id}` — the agent surface only
(UI path unchanged). Sub-skill: [alerts-write](alerts-write.md).

Until now the server silently accepted any `launchpads` / `booleanFilters` /
`minMaxFilters` content — invalid values produced alerts that match zero
coins and break the owner's UI. Now invalid bodies are rejected with the
same structured 400 contract as `POST /swap`: `error` code plus `message`,
`missing` / `invalid`, `allowed`, `example`, `docs`.

What gets rejected:

- `launchpads` not in the 9-key whitelist (DEX names like `raydium` /
  `orca` / `meteora` / `jupiter` → `invalid_launchpads`)
- create without `name` / without `launchpads`
- `booleanFilters` outside the 5-key whitelist
- `minMaxFilters` keys the engine doesn't support, or values that aren't
  `null` / `[min, max]` tuples (flat numbers → 400 with a tuple example)

Also: bodies that carry `launchpads` but omit `booleanFilters` /
`minMaxFilters` are now normalised server-side to `[]` / `{}` — previously
the missing keys vanished from the stored config and broke the alerts UI.

**What to do:**

- Nothing if you already follow the whitelists added on 2026-06-09 (below).
- On a 400, read `invalid` / `allowed` / `example` and retry once with a
  corrected body. If the second attempt also 400s, surface to the owner.

**Roll-out:** ✅ prod (2026-06-12 release).

---

## 2026-06-09 — `alerts_write`: explicit whitelists for `launchpads` and `booleanFilters`

**Where:** [alerts-write](alerts-write.md).

The body example previously used `"launchpads": ["pumpfun", "raydium"]` —
both invalid (correct key is `pf`; `raydium` is a DEX, not a launchpad).
Agents picked up the bad pattern and saved alerts with launchpads like
`["raydium", "orca", "meteora"]`. Backend silently accepted them, the
alert matched zero coins, and the UI choked rendering the broken config.

Also fixed: `minMaxFilters` example used `min_mc_usd` / `max_mc_usd` flat
keys (that's `snapshot_scan`'s shape, not alerts') — replaced with the
correct tuple form `"mc": [50000, 1000000]`.

**What to do:**

- Use ONLY the 9 launchpad keys listed in the new whitelist section
  (`pf`, `letsbonk`, `believe`, `bags`, `moonshot`, `jupstudio`, `rl`,
  `dbc`, `mayhem`). DEX names are not launchpads — if the owner wants
  "migrated coins", use `booleanFilters: ["only_migrated"]`.
- Use ONLY the 5 boolean filter keys listed in the new whitelist.
- `minMaxFilters` values are 2-tuples `[min, max]`, not flat
  `min_<k>` / `max_<k>` keys.

**Roll-out:** ✅ skill update only. Backend validation of launchpad keys
on `POST /alerts` is a separate fix coming on the backend side — until
then, the skill IS the contract.

---

## 2026-06-02 — Fixed silent swap failures at `slippage_p = 100`

**Where:** `POST /swap` (and every internal swap path — UI, autobuy,
alert autobuys). Sub-skill: [swap](swap.md).

Swaps with `slippage_p = 100` were silently failing on Pumpfun-bonded
coins and on the SPL Token close-ATA flow (visible in `error_text` as
either `custom program error: 0xbbb` or `Non-native account can only be
closed if its balance is zero`). Fixed server-side — `slippage_p = 100`
now produces the intended "accept any reasonable price" behaviour
instead of an on-chain error.

No client-side changes needed; the request contract is unchanged
(`slippage_p: 0..100`). If you were previously avoiding `100` by
manually dropping to `99` / `70` etc., you can stop — `100` is safe
again.

**Roll-out status:** ✅ prod.

---

## 2026-06-02 — `/alerts/triggered/:coin_address` — bad input now 400, not 500

**Where:** `GET /alerts/triggered/:coin_address` — same handler under both
Agent API (`/agent_stream/...` neighbour at `/agent/...`) and the web/TMA
surface (`/trading_bot/...`). Sub-skill: [alerts-read](alerts-read.md).

**What changed:** Handler now validates the path param via
`isValidSolanaAddress` before calling `cleanSolanaAddress` (which internally
constructs a `PublicKey` and throws on any non-32-byte base58). Previously
the throw was caught by the generic `try/catch` and turned into
`500 Server Error` with a generic body — confusing for agents that
mistakenly passed an `alert_id` or a valid-looking-but-short mint
(production case: a 38-character base58 that decoded to <32 bytes).

The response on bad input is now:

```json
{
  "error_text": "Invalid coin_address: expected a base58 Solana mint (32 bytes / 32–44 chars). The path param is a coin mint, not an alert_id.",
  "got": "<whatever you passed>"
}
```

Driven by 200+ 500s in `db.agent_event` across 5 users over the 8–13 May
window, every one of them landing on the same code path. The valid-input
path is unchanged.

**What the agent should do:**
- Re-read the [alerts-read sub-skill](alerts-read.md) — the path param is
  a **coin mint**, not an `alert_id`. If you want per-alert detail, use
  `/alert/:id/stats`.
- On 400 from this endpoint, read `error_text` and `got` to confirm what
  you sent. Don't retry the same input.

**Roll-out status:** ✅ dev (`api.dev-1.mymadrobot.com`), ✅ prod
(`api.fasol.trade`).

Verified on dev with the four-case test matrix:

| Input                                                | Status | Body                                        |
|------------------------------------------------------|--------|---------------------------------------------|
| `14867` (alert_id by mistake)                        | 400    | `error_text` + `got: "14867"`               |
| `Dqu1qnnTKTkR6cE6GvDxNb9pyKZuqPyfCqpump` (38 chars)  | 400    | `error_text` + echo                         |
| `all`                                                | 400    | `error_text` + echo                         |
| `So11111111111111111111111111111111111111112` (valid) | 200   | `{ data: [] }` (happy path, untouched)      |

---

## 2026-06-02 — Two new live streams: smart_money_trades + calls

**Where:** new endpoints `GET /agent_stream/smart_money_trades` and
`GET /agent_stream/calls`. New sub-skills:
[smart-money-stream](smart-money-stream.md) and
[calls-stream](calls-stream.md).

**What changed:** Driven by a community request — agents now get the same
two live feeds the UI consumes:

- **`smart_money_trades`** — global SSE of every swap by any wallet in
  Fasol's curated SM cohort (`fadev.sol.smart_money_wallet`). Same
  `LiveTrade` payload as tracked-wallet-trades; cohort rank surfaces in
  `group_id`. Scope `read_wallets` (default-on). Optional
  `?wallets=ca1,ca2,...` (≤ 50) for server-side allow-list.
- **`calls`** — per-user SSE of caller publications from callers the user
  follows. Three event types: `call_init` (backfill on connect), `call_new`
  (live publications), `call_prices` (periodic price updates for cached
  coins). Server-side filtered against `tb_user_caller_subscription`,
  reuses the same REDIS_STAT pipeline that powers the `/callers` UI page.
  Scope `read_alerts`.

Both share the existing SSE tier (5 concurrent connections per key, no
rpm). Zero new Redis subscriptions — they reuse channels the UI already
consumes (`NEW_SMART_MONEY_TRADE`, `CALL_FEED_UPDATE`, `CALL_FEED_PRICES`).

**What the agent should do:**
- For copy-trading the curated SM cohort — switch from polling
  `wallet_search` to subscribing to `smart_money_trades`. Use
  `?wallets=` if you only want a subset.
- For following individual callers — make sure your owner has followed at
  least one caller on `fasol.trade/callers`, then subscribe to `calls`.
  Empty stream after `ready` means zero subscriptions; tell the owner.
- Apply the same SSE robustness rules as for `tracked_wallet_trades`:
  back off on 429, treat 401/403/404 as terminal, dedup within a session.

**Roll-out status:** ✅ dev (`api.dev-1.mymadrobot.com`), ✅ prod
(`api.fasol.trade`).

Verified on dev:
- **`smart_money_trades`** — 3-min curl test captured 4 live SM swaps + 12
  heartbeats at the documented 15s cadence. Payload matches the documented
  `LiveTrade` shape including `group_id` (cohort rank) and `wallet_label`.
- **`calls`** — end-to-end test through the real UI flow:
  `POST /trading_bot/calls` (caller) → `publishTyped(CALL_FEED_NEW)` →
  REDIS_STAT filter against `tb_user_caller_subscription` →
  `CALL_FEED_UPDATE` → agent SSE delivered `event: call_new` ~50 ms after
  the caller's POST. `event: ready` and initial `event: call_init` arrive
  immediately on connect as documented.

---

## 2026-05-29 — 404 = permanent: explicit guidance + telemetry

**Where:** parent [SKILL.md](../SKILL.md) "Be a good citizen" section, and
the [coin-stats](coin-stats.md) sub-skill.

**What changed:** Explicit guidance added that **a 404 from a
resource-keyed endpoint is permanent, not transient**. The coin / deployer
/ order is gone — drop it from the iteration set on the **first** 404,
don't retry.

Driven by `db.agent_event`: a single delisted mint accumulated
**2 143 × 404** in one week from one agent stuck in a polling loop
(another mint hit 2 128). Until now the skill only covered 429 / 502 /
504 — never said "404 means stop". Adding the rule explicitly.

**Applies to:** every resource-keyed path — `/coin/:ca/stats`,
`/coin/:ca/candles{,_fast}`, `/coin/:ca/orders`,
`/snapshot/coin/:ca/{history,agg,first_match}`, `/dev/:deployer`,
`/orders/:id`.

**What the agent should do:** on the first 404 from any of these, drop
the ID from your watch-list immediately and surface it to the user /
parent strategy. Don't decrease your polling interval, don't retry, don't
back off — none of that recovers a delisted mint.
