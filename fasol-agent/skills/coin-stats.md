# `coin_stats` — current snapshot for one coin

> **Sub-skill of [Fasol Agent](../SKILL.md).**

`GET /coin/{coin_address}/stats` — the full `CoinStat` snapshot for a coin.
**This is the primary input for every trading decision.**

Requires `read_coins`. Tier: `standard`.

## Request

```bash
curl -s -H "Authorization: Bearer $FASOL_API_KEY" \
  "$FASOL_API_BASE_URL/coin/<COIN_ADDRESS>/stats"
```

## Response — key fields

| Field | Type | Meaning |
|---|---|---|
| `price_usd` | string | Current price in USD |
| `mc` | string | Market cap (USD) |
| `ath` | string | All-time-high market cap (USD) |
| `drop_from_ath_p` | number | % drop from ATH price |
| `liq` | string | USD liquidity in the pair |
| `vol_5m` / `vol_3m` / `vol_1m` | string | USD volume over last N minutes |
| `is_migrated` | bool | True after migration from bonding curve to AMM |
| `launchpad` | string | `pf` = pump.fun, `rl` = LaunchLab, `bags`, `believe`, `letsbonk`, … |
| `pair_created_seconds_ago` | number | Seconds since pair creation (= since migration for migrated coins) |
| `coin_created_seconds_ago` | number | Seconds since the coin mint was created |
| `holders_count` | number | Distinct holders |
| `top_10_p` | string | % of supply held by top 10 wallets |
| `dev_hold_p` | string | % of supply still held by the deployer |
| `snipers_hold_p` | string | % held by snipers (early-block buyers) |
| `bundlers_hold_p` | string | % held by bundle wallets |
| `fresh_count` / `fresh_hold_p` | number / string | Count + % of "fresh" wallets |
| `bot_traders_count` / `bot_traders_hold_p` | number / string | Bot wallets (Axiom, Padre, etc.) |
| `buy_tx_count` / `sell_tx_count` / `tx_count` | number | Tx counts since creation |
| `deployer` | string | Deployer wallet address (use with [`dev_history`](deployer.md)) |
| `dev_pf_launched_count` | number | How many pump.fun coins this deployer launched |
| `dev_pf_migrated_count` | number | How many of those migrated |
| `dev_pf_migrated_p` | number | Migration rate % |
| `dev_last3_avg_ath` | number | Avg ATH market cap of deployer's last 3 pf/letsbonk coins |
| `dev_last_migrated` | bool | Did the deployer's previous launch migrate? |
| `with_socials` | bool | True if coin has at least one of: twitter / telegram / web |
| `dex_paid` | bool | DEX promotion paid |
| `is_mayhem_mode` | bool | Extreme volatility flag |
| `migration_p` | number | % progress along bonding curve (only for non-migrated) |

## When to use

- Before any trade: sanity-check `liq`, `holders_count`, and the dev-hold /
  snipers-hold flags.
- Filtering candidates from streams (e.g. only mirror trades when
  `dev_hold_p < 10`).
- One-shot context fetch when an alert fires.

For **historical state** of the same coin, use
[`snapshot_history`](snapshot-history.md). For **point-in-time discovery** of
coins matching a filter, use [`snapshot_scan`](snapshot-scan.md). For real-time
price ticks, use [`coin_price_stream`](coin-price-stream.md).

## 404 on `coin_stats` means the coin is gone — stop polling

If `GET /coin/:ca/stats` returns **404**, the mint has been removed from the
platform's active set (unlisted, never traded above the liquidity floor,
delisted by ops, etc.). **It is permanent.** Don't retry, don't back off,
don't decrease your interval — the next request will also 404, and the one
after that.

**What to do:**

1. Remove this `coin_address` from your watch-list / iteration set
   immediately, on the **first** 404.
2. If a user / parent strategy is tracking this coin, surface the dropped
   ID so they know to retire it.
3. Treat it as a terminal state for that mint, not as a transient error.

Production telemetry from one week:

- one delisted mint received **2 143 × 404** from a single agent (≈ 13/min
  for 4 hours, repeated daily) — the loop never stopped.
- another received **2 128 × 404** under the same pattern.
- both burnt their owners' standard-tier budgets and produced zero useful
  data.

The same rule applies to every coin-keyed endpoint: `/coin/:ca/candles`,
`/coin/:ca/candles_fast`, `/coin/:ca/orders`, `/snapshot/coin/:ca/history`,
`/snapshot/coin/:ca/agg`, `/snapshot/coin/:ca/first_match`,
`/dev/:deployer`. A 404 on any of these is the resource saying "I don't
exist anymore" — never the network or the platform saying "try again".
