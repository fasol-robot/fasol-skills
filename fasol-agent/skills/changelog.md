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
