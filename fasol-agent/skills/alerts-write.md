# `alerts_write` — create / update / pause / autobuy

> **Sub-skill of [Fasol Agent](../SKILL.md).** For reading alerts see
> [alerts-read](alerts-read.md). For multi-day backtests of an
> AlertConfig see [alert-simulate](alert-simulate.md).

All write endpoints require `manage_alerts` — a scope that **isn't granted by
default**; your owner must explicitly hand it over. Tier: `medium`.

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/alerts` | Create alert. Body = full `AlertUpsertData` |
| `PUT` | `/alert/{alert_id}` | Update alert. Same body. **Filter change clears match history.** |
| `DELETE` | `/alert/{alert_id}` | Delete alert and its match history |
| `POST` | `/alert/{alert_id}/pause` | `is_paused = true`. Empty body. Idempotent |
| `POST` | `/alert/{alert_id}/unpause` | `is_paused = false`. Empty body. Idempotent |
| `POST` | `/alert/{alert_id}/toggle-telegram` | Flip `should_send_tg`. Empty body |
| `POST` | `/alert/{alert_id}/autobuy` | Set autobuy config (see below). Pass `null` / `0` to disable |

## `AlertUpsertData` body

```jsonc
{
  "name": "Migrated + dev sold",
  "launchpads": ["pf", "letsbonk"],             // ≥1 required, see whitelist below
  "booleanFilters": ["only_migrated", "with_socials", "dex_paid"],
  "minMaxFilters": {                            // any subset; tuple [min, max], null on either side
    "mc":              [50000, 1000000],
    "vol_5m":          [10000, null],
    "holders_count":   [200, null],
    "dev_hold_p":      [null, 5]
    // Full key list — same as alert-simulate's minMaxFilters (every CH column
    // on db.coin_snapshot gets a tuple filter). NEVER use flat `min_<col>` /
    // `max_<col>` keys here — that's the snapshot_scan shape, not alert's.
  },
  "milestones": [1.5, 2, 5, 10],                // multipliers tracked after match
  "is_paused": false,
  "chat_id": null,                              // null = DM the bot owner

  // Autobuy (optional — fire-and-forget buys when the alert matches)
  "autobuy_amount": 0.05,                       // SOL per match; null/0 disables
  "autobuy_orders": [                           // TP / SL / trailing armed after the buy
    { "trigger_p": "50",  "sell_p": "100" },    // TP:  positive trigger_p
    { "trigger_p": "-25", "sell_p": "100" }     // SL:  negative trigger_p
  ],
  "ab_fee": 0.001,
  "ab_slip": 0.5,
  "ab_jito_on": false
}
```

Server enforces (agent surface): `name` non-empty, ≥1 launchpad from the
whitelist below, `booleanFilters` / `minMaxFilters` keys from their
whitelists, min/max values as `[min, max]` tuples, sufficient SOL balance
when `autobuy_amount > 0`. Invalid bodies get a structured 400 (`error`,
`message`, `invalid` / `missing`, `allowed`, `example`, `docs`) — fix and
retry once; if the second attempt also 400s, surface to the owner.
Omitted `booleanFilters` / `minMaxFilters` are normalised to `[]` / `{}`.
Returns the saved row (`{ data: alert }`).

### `autobuy_orders` entry format — exact shape, no `type` key

There is **no `type` field** — the order kind is derived from which keys you
send and the SIGN of the value. All numeric values are **strings**:

| Kind          | Shape                                                        |
|---------------|--------------------------------------------------------------|
| Take profit   | `{ "trigger_p": "50",  "sell_p": "100" }` — trigger_p > 0    |
| Stop loss     | `{ "trigger_p": "-25", "sell_p": "100" }` — trigger_p < 0    |
| Trailing stop | `{ "trailing_p": "10", "sell_p": "100", "activation_p": "0" }` |

`trigger_p` / `trailing_p` are percent moves from entry; `sell_p` is the % of
the position to sell (0 < sell_p ≤ 100). Exactly one of `trigger_p` /
`trailing_p` per entry.

⚠️ Sending a `type` key or bare JSON **numbers** (`"trigger_p": 50`) is NOT
rejected today: the buy and the armed orders still execute, but the owner's
web UI fails to render that alert's Autobuy settings and shows *"invalid
config"* with a Delete prompt. Send string values exactly as above.

> ⏳ Next backend release adds server-side normalization on the agent
> surface: numbers are auto-coerced to strings, a `type` key consistent
> with the values is stripped, and contradictory / malformed entries get a
> structured `400 invalid_autobuy_orders` (with `invalid` + `example`).
> The canonical string format above works identically before and after.


### `launchpads` — closed whitelist

Use ONLY these exact keys. **`launchpads` is the launchpad/protocol where the
coin was minted, NOT the DEX it later trades on.** Common LLM mistake:
filling it with DEX names (`raydium`, `orca`, `meteora`, `jupiter`) — backend
silently accepts those today but the alert matches **zero** coins and the
UI gets confused rendering the bad config.

| Key | Project |
|---|---|
| `pf` | Pump.fun |
| `letsbonk` | LetsBonk |
| `believe` | Believe |
| `bags` | Bags |
| `moonshot` | Moonshot |
| `jupstudio` | Jup Studio |
| `rl` | LaunchLab |
| `dbc` | Meteora DBC |
| `mayhem` | Mayhem (virtual — matches `is_mayhem_mode = 1` coins regardless of real launchpad) |

If you want "any launchpad", enumerate all 9 keys. There is no `"all"`
shortcut. If the owner asks for "migrated to Raydium/Meteora/Orca",
that's a **boolean filter** (`"only_migrated"` in `booleanFilters`), not
a launchpad value.

### `booleanFilters` — closed whitelist

```
with_socials      // coin has any of web / tg / twitter
only_migrated     // already migrated off launchpad to a real DEX pair
dex_paid          // DEX listing fee paid (Dexscreener "paid" badge)
is_cashback_coin  // coin is in the Fasol cashback program
dev_last_migrated // deployer's previous coin migrated
```

Anything else → backend rejects or the alert silently never matches.

### `minMaxFilters` keys

Same set as `/alert/simulate` — see [alert-simulate](alert-simulate.md#body-shape)
for the full enumerable list. Notable ones the UI uses most:
`mc`, `ath`, `liq`, `vol_5m`, `holders_count`, `coin_created_seconds_ago`,
`migration_p`, `dev_hold_p`, `top_10_p`, `drop_from_ath_p`, `global_fees`.
Each value is a 2-tuple `[min, max]` with either side nullable.

## Pause / autobuy shims — no round-trip on full config

```bash
# Pause
curl -s -X POST -H "Authorization: Bearer $FASOL_API_KEY" \
  "$FASOL_API_BASE_URL/alert/123/pause"

# Set autobuy size + TP/SL
curl -s -X POST -H "Authorization: Bearer $FASOL_API_KEY" -H "Content-Type: application/json" \
  -d '{"autobuy_amount":0.05,"autobuy_orders":[{"trigger_p":"50","sell_p":"100"},{"trigger_p":"-25","sell_p":"100"}]}' \
  "$FASOL_API_BASE_URL/alert/123/autobuy"

# Disable autobuy (preserves the rest of the alert)
curl -s -X POST -H "Authorization: Bearer $FASOL_API_KEY" -H "Content-Type: application/json" \
  -d '{"autobuy_amount":null,"autobuy_orders":null}' \
  "$FASOL_API_BASE_URL/alert/123/autobuy"
```

### Which wallet the autobuy fires from

Autobuy executes from **your agent's bound wallet by default** — the same
wallet `/swap` and `/orders` use. You do **not** need to pass `ab_wallet`:
set autobuy with the key of the agent bound to wallet X, and matches buy
from wallet X. Pass an explicit `ab_wallet` (must be one of the owner's
wallets) only if you want the autobuy to fire from a *different* wallet than
the agent's own. This holds for both `POST /alert/{id}/autobuy` and the full
`POST /alerts` / `PUT /alert/{id}` upsert.

> ⏳ Ships with the next backend release. Until then, pass `ab_wallet`
> explicitly if you need the autobuy on a specific wallet — the pre-release
> default is the account's active wallet, not the agent's.

## Lifecycle gotchas

- **Filter change clears match history.** `PUT /alert/:id` with a different
  `booleanFilters` / `launchpads` / `minMaxFilters` triggers
  `clearAlertHistory(alert_id)` server-side. `triggered_count` resets and
  `stat_*` go null until new matches accumulate.
- **Autobuy positions tag `source_kind: "alert"` + `source_id: <alert_id>`.**
  With `manage_alerts` scope you may treat them as yours (cancel TP/SL, exit
  early, etc.) — without it, don't touch.
- **Tune filters with the backtest first.** Use [alert-simulate](alert-simulate.md)
  to validate a filter set against last 1-5 days BEFORE pushing it live with
  `PUT /alert/:id`. Avoids burning days of `triggered_count` history on a
  filter that turns out to over-match.
