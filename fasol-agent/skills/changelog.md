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

**Roll-out status:** ⏳ shipping in the next backend release.

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

---

## 2026-05-29 — Self-correcting 400 responses on write endpoints

**Where:** `POST /swap`, `POST /orders`, `DELETE /orders/:id` (sub-skills:
[swap](swap.md), [place-order](place-order.md), [cancel-order](cancel-order.md)).

**What changed:** 400 responses on the write endpoints now include
structured diagnostics so the agent can self-correct on the next attempt
without a human in the loop. The stable `error` code is unchanged
(backward-compatible); the response body gains:

- `message` — one-sentence human-readable explanation
- `missing` — list of required fields absent from the body
- `invalid` — list of fields present but malformed
- `allowed` — enum values when relevant (e.g. order `type`, swap `direction`)
- `got` — sanitised view of what the server received
- `example` — a minimal valid body for this endpoint / variant
- `docs` — URL to the sub-skill that documents the endpoint

Driven by a week of `db.agent_event` audit data: one production agent
attempted `POST /swap` 88 times with `400 invalid_body` and got no hint of
what was wrong each time. With the new shape, the response itself shows
the correct example body and the missing field name.

**What the agent should do:**
- On any 400 from a write endpoint, read `body.example` and `body.missing`
  / `body.invalid` first — they tell you exactly what to fix.
- If the response includes `docs`, that's the canonical reference for the
  full endpoint contract. Don't hammer the endpoint with guesses; read the
  sub-skill once and retry with a corrected body.

**Roll-out status:** ✅ dev (`api.dev-1.mymadrobot.com`), ⏳ prod
(`api.fasol.trade`) — TBD with the next backend release.

Verified on dev with seven curl probes covering every error case in
`POST /swap`, `POST /orders`, and `DELETE /orders/:id` — each response
returned the documented shape (`error`, `message`, `missing` / `invalid`,
`got`, `example`, `docs`).

---

## 2026-05-28 — Skill split: monolith → sub-skill catalog

**Where:** entire `fasol-agent/` repo layout.

**What changed:** The monolithic `SKILL.md` (~2200 lines covering every
endpoint inline) was split into one focused sub-skill per capability under
`skills/*.md`. The top-level `SKILL.md` is now a thin index (~290 lines)
covering shared context (auth, rate limits, wallet binding, core concepts)
plus links to sub-skills. The new [`skills.json`](../skills.json) is a
machine-readable catalog (same shape as GMGN's) for programmatic discovery;
[`skills/INDEX.md`](INDEX.md) is its human-readable twin.

27 sub-skill files were extracted, covering every documented endpoint and
SSE stream.

**What the agent should do:**
- On daily refresh, read `SKILL.md` + this changelog first (as before).
- For specific operations, read **only the matching `skills/*.md`** — don't
  preload the others. Context savings are the whole point of the split.
- If a sub-skill file doesn't exist for the operation you need, fall back
  to the legacy `SKILL.md` and report the gap so it can be added.

---

## 2026-05-28 — SSE `tracked_wallet_trades`: silent-stop fixed (dev + prod)

**Where:** `GET /agent_stream/tracked_wallet_trades` (sub-skill:
[tracked-wallet-trades](tracked-wallet-trades.md)).

**What changed:** Root cause of the "connection alive 10+ min silently
stops delivering events while heartbeats keep arriving" bug was identified
and fixed. The cross-process `REDIS_STAT.liveTradesTrack` cache hard-evicted
a user from its `walletToUsers` map after 30 min without any swap on their
tracked wallets — heartbeats kept arriving from the WS process (they're
local; no cross-process dependency), so the connection looked fine, but
events stopped dispatching. Fix: WS now re-publishes `JOINED_LIVE_TRADES`
every ~60s from the heartbeat timer, idempotently refreshing `userLastSeen`.
Eviction can no longer fire while a SSE is alive.

**Roll-out status:** ✅ dev (`api.dev-1.mymadrobot.com`), ✅ prod
(`api.fasol.trade`).

Verified on dev with a 4-min SSE test: heartbeats every 15s, JOIN keepalive
every 60s (REDIS_STAT log: `User cache updated for live trades` 4 times in
4 minutes), no event delivery interruption.

**What the agent should do:**
- The 4-min `withReconnect()` client-side workaround **was retired** from
  `scripts/lib/sse.mjs` along with this fix. Any external strategy that
  still imports it will fail to import — drop the wrapper, use the bare
  `subscribe*` generators (they already auto-reconnect on transient drops
  via streamSSE's built-in backoff).
- If silent-stop is ever observed again on either dev or prod — it's a
  different cause (probably ioredis subscription state loss); report to
  the skill owner for separate investigation.

---

<!-- ┌────────────────────────────────────────────────────────────────────┐
     │ Добавление новой записи — workflow                                │
     ├────────────────────────────────────────────────────────────────────┤
     │ 1. Вставить новую запись **под этим разделителем** (сверху).     │
     │ 2. Если в файле уже 10 записей, удалить самую старую (внизу).    │
     │ 3. Обновить дату в верхней записи (формат YYYY-MM-DD).            │
     │ 4. Один коммит на одно изменение — тогда git log даёт полную     │
     │    историю, а этот файл — последние 10 изменений.                │
     └────────────────────────────────────────────────────────────────────┘ -->
