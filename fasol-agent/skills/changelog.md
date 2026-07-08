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

**Roll-out convention:** каждая запись несёт дату релиза ("release
YYYY-MM-DD"). Статус прода помечается ⏳ до следующего дня, когда
maintainer-агент проверяет прод (логи/пробы) и переворачивает в ✅.
Если видишь ⏳ с датой в прошлом — фича почти наверняка уже на проде,
просто ещё не верифицирована.

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

## 2026-07-09 — NEW endpoint: `GET /wallet/{wallet}/trades` (per-wallet buy performance)

**Where:** new sub-skill [wallet-trades](wallet-trades.md). Scope
`read_wallets`, tier `heavy` (5 rpm).

Answers "how did the coins this wallet bought perform?" for ANY Solana
wallet — per-coin fold of its swaps over `interval=1d|7d|14d|30d`
(default 7d): SOL in/out, tokens held, buy/sell counts, first/last tx
timestamps, fees, and realised + mark-to-market `pnl_sol` / `pnl_percent`
against the live price, plus wallet-level `total_pnl_sol`. Same data and
same 30 s server cache as the web wallet drawer.

Fasol still has **no retroactive per-buy "call" log** — this endpoint gives
the per-coin aggregate history; for tick-level entries keep stamping from
the [tracked-wallet-trades](tracked-wallet-trades.md) SSE stream going
forward.

**What to do:**

- Backfill once per tracked wallet
  (`GET /wallet/{w}/trades?interval=30d`), then update incrementally from
  the SSE stream — do NOT poll this endpoint (heavy tier will 429 loops).
- Entry price per coin = `in_sol / in_coin`; post-buy multiple of the coin
  itself → [candles](candles.md) after `last_buy`.

**Roll-out:** release 2026-07-09 — ✅ dev (verified end-to-end 2026-07-09); prod: rolling out, flips to ✅ after the 2026-07-10 verification.
If it still 404s on prod, don't mark the endpoint permanently dead —
recheck after your next skill refresh.

---

## 2026-07-08 — reads default to the BOUND wallet; agent cap 10 → 20

**Where:** `GET /positions`, `GET /orders`, `GET /coin/:ca/orders`,
`GET /trades`. Sub-skills: [list-positions](list-positions.md),
[list-orders](list-orders.md), [list-trades](list-trades.md),
[get-scope](get-scope.md).

Until now the read endpoints did NOT look at the wallet your key is bound
to: `/positions` and both `/orders` lists read the account's *active*
wallet (whatever the owner had selected in the UI), and `/trades` returned
every wallet of the account with no `wallet` field to filter on. Practical
symptoms: an agent couldn't see the orders it had just placed via
`place_order`, and positions/trades didn't match the wallet `/swap` fires
from.

Fixed: all four reads now default to the **bound wallet** — the same lens
as `/swap`, `POST /orders` and `/wallet_balance`. Additions:

- `/trades` accepts `?wallet=<addr>` (another owned wallet) and
  `?wallet=all` (the old account-wide view); rows now carry `wallet`, and
  the response echoes the active lens top-level.
- `/positions` response gains a top-level `wallet` echo.
- Legacy keys without a wallet binding keep the old account-wide/active
  behavior.

**What to do:**

- Nothing, if you already assumed reads were "my wallet" — now they are.
- If you RELIED on account-wide `/trades`, pass `?wallet=all` explicitly.
- Drop client-side wallet-filter workarounds once the release lands.

*Account note: the active-agents-per-user cap rises 10 → 20 in the same
release (one key per wallet scales further). 409 semantics unchanged.*

**Roll-out:** release 2026-07-09 — ✅ dev (verified end-to-end 2026-07-09); prod: rolling out, flips to ✅ after the 2026-07-10 verification.

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

**Roll-out:** doc fix live since 2026-07-08. Server-side normalization
(`POST /alerts`, `PUT /alert/:id`, `POST /alert/:id/autobuy`: numbers
auto-coerced to strings, consistent `type` keys stripped, contradictory /
malformed entries → structured `400 invalid_autobuy_orders`): release
2026-07-09 — ✅ dev (verified end-to-end 2026-07-09); prod: rolling out, flips to ✅
after the 2026-07-10 verification.

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

**Roll-out:** ✅ dev, ✅ prod (verified in prod logs 2026-07-07).

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

**Roll-out:** ✅ dev, ✅ prod (2026-07 release; shipped together with the
2026-07-04 SSE fix).

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
