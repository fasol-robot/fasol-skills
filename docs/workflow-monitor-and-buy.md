# Workflow — Monitor a coin, buy with TP/SL, exit on dev-sell

End-to-end walkthrough for the most common Fasol agent use case: watch a coin, enter at a target price, set TP/SL, monitor the deployer.

## Prompt

```
I want you to watch coin {COIN_ADDRESS}.

If the price drops to $0.0000123, buy 0.1 SOL.
After the buy, set:
  - Take profit at +50% from entry (sell 100%)
  - Stop loss at -25% from entry (sell 100%)

Every 5 minutes, check the deployer's wallet via dev_history.
If the deployer has sold more than 5% of their bag since the position opened,
exit my entire position immediately.

Otherwise, just keep an eye on the position and report PnL changes.
```

## What the agent should do

### 1. Confirm scope

```bash
node scripts/get-scope.mjs
```

Required scopes for this workflow: `read_coins`, `read_positions`, `read_dev_history`, `place_orders`. If any are missing, surface the gap to the user — don't try to work around it.

### 2. Pre-trade due diligence

```bash
node scripts/coin-stats.mjs <COIN_ADDRESS>
```

Inspect:
- `liq` — should be > $1k for a sane buy
- `is_migrated` — entries on the bonding curve are different from AMM (this skill targets migrated AMM coins)
- `top_10_p` — concentration risk
- `dev_hold_p` — how much of the supply the deployer still holds (watch for them to dump)
- `pair_created_seconds_ago` — time since migration, < 24h is "fresh"
- `deployer` — capture this; you'll use it for the dev-history poll

### 3. Confirm with the user (REQUIRED — no silent execution)

Print:

```
🎯 Buy plan — confirm before I submit

  Coin:      BONK (DezX...)
  Liquidity: $45,000    Market cap: $1,234,567    Price: $0.0000123
  Age:       60m since migration
  Holders:   4,521    Top-10 hold: 18.2%
  Dev hold:  1.2%    Dev migrated: 25% of 12

  Action:
   - Limit buy 0.1 SOL at $0.0000123
   - Take profit at +50% from entry (sells 100%)
   - Stop loss at -25% from entry (sells 100%)

  Risk flags: none

  Reply "confirm" to submit.
```

Wait for `confirm`. Do not proceed without it.

### 4. Submit the orders

```bash
node scripts/place-order.mjs limit_buy   --coin <COIN_ADDRESS> --trigger-price 0.0000123 --amount-sol 0.1
node scripts/place-order.mjs take_profit --coin <COIN_ADDRESS> --trigger-p  50 --sell-p 100
node scripts/place-order.mjs stop_loss   --coin <COIN_ADDRESS> --trigger-p -25 --sell-p 100
```

Capture each `id` (`ord_...`). The TP/SL queue immediately and arm against the actual entry price once the limit-buy fills.

### 5. Confirm submission

```
✅ Submitted

  Limit buy:    ord_abc123  (waiting for $0.0000123)
  Take profit:  ord_def456  (will arm after fill)
  Stop loss:    ord_ghi789  (will arm after fill)

  I'll notify you when the buy fills.
```

### 6. Monitor loop (every 5 minutes)

a. **Check dev** — fetch the deployer's tokens; check whether their wallet balance dropped:

```bash
node scripts/coin-stats.mjs <DEPLOYER_ADDRESS>     # (or implement a dev-balance helper)
```

If the deployer sold more than 5% since position-open: place an immediate sell — `node scripts/place-order.mjs limit_sell --coin <COIN_ADDRESS> --trigger-price 0 --sell-p 100` (trigger-price 0 = sell at any price, i.e. market).

b. **Check position** — fetch your open positions:

```bash
node scripts/list-positions.mjs
```

If unrealized PnL changed by more than ±5% since the last update, post a status line. Otherwise stay quiet.

### 7. On exit

When TP / SL / dev-guard fires, the position closes server-side. The next `list-positions` call will no longer show it. Post a final summary:

```
🏁 BONK closed

  Entry:  $0.0000123
  Exit:   $0.0000185 (+50% take-profit hit)
  PnL:    +0.05 SOL
```

## Edge cases

- **Buy never fills.** Limit-buy waits indefinitely until cancelled. If the coin pumps without dipping to your trigger, you'll just sit there. Tell the user — they may want to bump the trigger up or cancel.
- **Buy fills, then dev sells before TP/SL arm.** The TP/SL arm on `SUCCESS_FASOL_SWAP` (the buy confirmation), so the window between fill and arm is small but nonzero. The dev-guard polling provides the safety net.
- **Server returns 429.** Back off `Retry-After` seconds. Resume when allowed. Do not retry-storm.
- **Server returns 403 missing_scope.** Stop and tell the user the scope is missing. Don't loop.
