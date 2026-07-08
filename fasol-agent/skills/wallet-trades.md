# `wallet_trades` — per-wallet trade performance (how did its buys do?)

> **Sub-skill of [Fasol Agent](../SKILL.md).** Companion to
> [wallet-search](wallet-search.md) (discover wallets) and
> [tracked-wallets](tracked-wallets.md) (follow them live).

`GET /wallet/{wallet}/trades?interval=1d|7d|14d|30d` — per-coin fold of the
wallet's swaps with mark-to-market PnL: for every coin the wallet traded in
the window you get SOL in, SOL out, remaining balance, and PnL against the
live price. This is the historical answer to *"how do the tokens this wallet
buys perform?"* — the same data the Fasol web UI shows in the wallet drawer.

Requires `read_wallets`. Tier: **`heavy` (5 rpm)** — designed as a one-shot
backfill per wallet, not a poll target (see usage pattern below).

> ⏳ Release 2026-07-09: ✅ dev (2026-07-09, verified end-to-end); prod: rolling out from 2026-07-09, status flips to ✅ after the 2026-07-10 verification.
> If it still 404s on prod, do NOT treat that as "endpoint permanently
> gone" — retry after your next skill refresh.

## Request

```bash
# Default window: 7d
curl -s -H "Authorization: Bearer $FASOL_API_KEY" \
  "$FASOL_API_BASE_URL/wallet/<WALLET>/trades"

# Explicit window
curl -s -H "Authorization: Bearer $FASOL_API_KEY" \
  "$FASOL_API_BASE_URL/wallet/<WALLET>/trades?interval=30d"
```

| Param | Default | Notes |
|---|---|---|
| `wallet` (path) | — | any Solana wallet — public on-chain analytics, not limited to tracked/owned wallets |
| `interval` | `7d` | `1d` \| `7d` \| `14d` \| `30d` — coins with a **still-open position always show** regardless of window; the interval filters closed positions by last activity |

## Response

```json
{
  "data": {
    "wallet": "Cs7c...",
    "interval": "7d",
    "sol_balance": 12.5,
    "total_pnl_sol": 3.21,
    "trades": [
      {
        "coin_address": "...",
        "symbol": "BONK",
        "image": "https://...",
        "in_sol": 1.5,           // SOL spent buying
        "in_coin": 812345.6,     // tokens bought
        "out_sol": 2.4,          // SOL received selling
        "out_coin": 500000.0,    // tokens sold
        "coin_balance": 312345.6,// tokens still held (0 = closed)
        "buy_count": 3,
        "sell_count": 1,
        "first_tx_at": 1745779200000,  // unix ms
        "last_buy":    1745779300000,
        "last_tx_at":  1745781600000,
        "fees": 0.012,
        "price_usd": 0.0000234,        // current price
        "pnl_sol": 1.02,               // realised + mark-to-market vs live price
        "pnl_percent": 68.0,
        "coin_created_at": 1745700000000,
        "deployer": "..."
      }
    ]
  }
}
```

Field notes:

- **Numbers are JSON numbers here** (analytics floats), unlike the
  string-money convention on trading endpoints — this is aggregate CH data,
  not lamport-exact accounting.
- **`pnl_sol` / `pnl_percent`** — realised part plus the remaining
  `coin_balance` marked to the live price. `null` (with
  `has_unknown_sells: true`) when the wallet sold more than the platform saw
  it buy — PnL would be a guess, so it isn't one.
- **Average entry price** = `in_sol / in_coin` (SOL per token). Combine with
  [candles](candles.md) or [snapshot-history](snapshot-history.md) after
  `last_buy` to compute the post-buy multiple / drawdown of the coin itself.
- A dead pool (drained liquidity) marks the live price 0 → open bags show
  as full loss, matching the UI.

## Usage pattern — backfill once, then stream

The intended loop for "performance of my tracked wallets' buys":

1. `GET /tracked_wallets` → your list.
2. For each wallet, ONE `GET /wallet/{w}/trades?interval=30d` — historical
   per-coin performance. At 5 rpm, 20 wallets take ~4 minutes; results are
   server-cached 30 s, so re-asking the same wallet is near-free.
3. Subscribe to [tracked-wallet-trades](tracked-wallet-trades.md) SSE — every
   NEW buy/sell arrives live; update your local stats incrementally.
4. Re-pull a wallet's trades only on reconcile (e.g. daily), not on a timer.

Don't iterate this endpoint as a poll — the SSE stream is the live path, and
the heavy tier will 429 tight loops by design.

## Worked example — hit-rate of one tracked wallet

```js
const r = await api("GET", `/wallet/${w}/trades?interval=30d`);
const t = r.data.trades.filter(x => x.pnl_sol !== null);
const wins = t.filter(x => x.pnl_sol > 0);
console.log(
  `${w}: ${t.length} coins, ` +
  `win-rate ${(100 * wins.length / t.length).toFixed(0)}%, ` +
  `net ${r.data.total_pnl_sol.toFixed(2)} SOL`
);
```
