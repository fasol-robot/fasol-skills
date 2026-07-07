# `list_trades` — realised trade history (source of truth for PnL)

> **Sub-skill of [Fasol Agent](../SKILL.md).** Auth, tier (`medium`), and
> wallet binding in parent.

`GET /trades` is the source of truth for realised PnL. When a TP / SL /
trailing order fires, the order entity loses its sell-side data (it gets
reset for re-arming). The actual sell price, sell SOL, and tx hash live in
`sol.tb_tx`. This endpoint surfaces them.

Requires `read_positions`.

**Wallet lens:** defaults to your **bound wallet** — the trades you see are
the trades of the wallet you fire. `?wallet=<addr>` narrows to another of
the owner's wallets, `?wallet=all` gives the account-wide view. Each row
carries a `wallet` field, and the response echoes the active lens top-level.

> ⏳ Ships with the next backend release. Until then the endpoint always
> returns ALL of the account's wallets and rows have no `wallet` field —
> recognise your own trades via `source_kind === "agent"` (orders-engine
> fires) / `tx_type === "agent_swap"` (your swaps).

## Request

```bash
# Default: last 24h, all coins, latest 100
curl -s -H "Authorization: Bearer $FASOL_API_KEY" "$FASOL_API_BASE_URL/trades"

# Scope to one coin + a specific window
curl -s -G -H "Authorization: Bearer $FASOL_API_KEY" \
  --data-urlencode "coin_address=<COIN>" \
  --data-urlencode "from_ts=1745779200000" \
  --data-urlencode "to_ts=1745782800000" \
  --data-urlencode "limit=200" \
  "$FASOL_API_BASE_URL/trades"
```

| Param | Default | Notes |
|---|---|---|
| `coin_address` | unset (all coins) | Solana mint |
| `from_ts` | `now - 24h` | unix ms |
| `to_ts` | `now` | unix ms |
| `limit` | `100`, max **`500`** | paginate further by lowering `to_ts` |
| `wallet` | bound wallet | `<addr>` = another owned wallet, `all` = account-wide (⏳ next release) |

## Response

```json
{
  "data": [
    {
      "id": 123456,
      "ts": 1745779200123,
      "hash": "5Qw...",
      "wallet": "Cs7c...",
      "coin_address": "...",
      "symbol": "BONK",
      "direction": "buy",
      "tx_type": "limit_buy",
      "amount_sol": "0.10000000",
      "amount_coin": "8123456.789",
      "amount_usd": "12.34",
      "price_usd": "0.000001518800",
      "price_sol": "0.000000012310",
      "fees_sol": "0.00000500",
      "fasol_fee_sol": "0.00006100",
      "order_id": "ord_abc",
      "source_kind": "agent",
      "source_id": "3",
      "error_text": null
    }
  ],
  "summary": { "total": 12, "buys": 6, "sells": 5, "failed": 1 },
  "window":  { "from_ts": 1745695200000, "to_ts": 1745781600000, "limit": 100 },
  "wallet":  "Cs7c..."
}
```

## Field semantics

- **`direction`** — `"buy"` or `"sell"`.
- **`tx_type`** — how this trade was originated. Values you'll see:
  - `limit_buy` / `limit_sell` — Fasol orders engine fired the trade
  - `take_profit` / `stop_loss` / `trailing` — relative-order fires (sells)
  - `ml_buy` / `ml_sell` — fired from an ml_order strategy
  - `agent_swap` — instant `/swap` you fired
  - `qb` / `terminal` — manual user trade (UI / Telegram quick-buy)
- **`order_id`** — id of the order that fired (orders-engine row, OR ml_order id). `null` for manual trades and `/swap` trades.
- **`source_kind` / `source_id`** — ownership tags.
  - `"agent" + <my_agent_id>` is yours **for orders-engine fires** (`limit_buy` / TP / SL / trailing).
  - **`/swap` trades come back with `source_kind: null` and `source_id: null`** — they don't ride through the orders pipeline. To recognise your own `/swap` output, filter by `tx_type === "agent_swap" && !error_text`. Trying `source_kind === "agent"` for swap-driven bots returns nothing and your reconcile logic will compute `pnl=0`.
- **`error_text`** — `null` for successful trades, a message for failed ones. Failed trades are **included** so you can see what didn't land.
- **`price_usd` / `price_sol`** — precomputed at 12dp so you don't divide JS floats. Already accounts for slippage at execution time — this IS the actual fill price.
- **`amount_usd`** — USD value at execution time. Use it for cycle PnL in USD without a separate price call.

## Worked example — realised PnL of one cycle

```js
// You opened a cycle for BONK at cycleStartTs (epoch ms). Now compute net PnL.
const r = await api("GET", `/trades?coin_address=${coin}&from_ts=${cycleStartTs}`);
const succ  = r.data.filter(t => !t.error_text);
const buys  = succ.filter(t => t.direction === "buy");
const sells = succ.filter(t => t.direction === "sell");

const sumBig = (xs) => xs.reduce((a, b) => a.plus(b), new BigNumber(0));
const solIn  = sumBig(buys.map(t  => new BigNumber(t.amount_sol)));
const solOut = sumBig(sells.map(t => new BigNumber(t.amount_sol)));
const fees   = sumBig(succ.flatMap(t => [
  new BigNumber(t.fees_sol),
  new BigNumber(t.fasol_fee_sol),
]));

const realisedPnlSol = solOut.minus(solIn).minus(fees);
const usdIn  = sumBig(buys.map(t  => new BigNumber(t.amount_usd)));
const usdOut = sumBig(sells.map(t => new BigNumber(t.amount_usd)));
const realisedPnlUsd = usdOut.minus(usdIn);  // fees are in SOL — multiply by SOL price for full USD net

console.log(`Cycle PnL: ${realisedPnlSol.toFixed(4)} SOL  (${realisedPnlUsd.toFixed(2)} USD)`);
```

For overall strategy PnL: same query without `coin_address`, sum across all cycles.
