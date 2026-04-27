#!/usr/bin/env node
/**
 * Strategy template — long-running per-coin loop.
 *
 * The agent customises this template (mostly the CONFIG block + the decide()
 * function), the owner runs it as a background process, and the agent reads
 * the log file when checking in.
 *
 * Usage (after the agent customises this for a specific coin):
 *   export FASOL_API_KEY="fsl_live_..."
 *   node strategy-bonk-dip-buy.mjs > strategy-bonk-dip-buy.log 2>&1 &
 *   # ... let it run ...
 *   pkill -f strategy-bonk-dip-buy.mjs   # stop
 *
 * The script logs one JSON object per line to stdout — easy to tail/grep.
 *
 * What this template gives you:
 *   - reads FASOL_API_KEY / FASOL_API_BASE_URL from env via lib/api.mjs
 *   - 30s default poll loop with graceful shutdown on SIGINT / SIGTERM
 *   - per-call 429 back-off
 *   - calls coin_stats, list_positions, place_order, cancel_order
 *   - structured logging
 *
 * What you (the agent) fill in:
 *   - CONFIG block (coin, thresholds, max time / max iterations)
 *   - decide() function — pure logic, no I/O
 */

import { api, log as cliLog } from "./lib/api.mjs";

// ─── CONFIG (the agent customises this whole block per coin / strategy) ────────

const CONFIG = {
  coin_address: "<COIN_MINT>",
  symbol:       "<SYM>",
  poll_seconds: 30,
  max_runtime_minutes: 6 * 60,    // hard stop after this many minutes
  max_iterations:      10_000,    // belt-and-braces upper bound

  // Custom params for decide() — anything you want.
  entry_price_usd:   0.0000110,   // example: dip-buy trigger
  amount_sol:        0.1,         // initial position size
  take_profit_p:     40,          // exit at +40% from entry
  stop_loss_p:       -20,         // exit at -20%
  vol_5m_floor_usd:  5000,        // emergency exit if 5m volume drops below this
};

// ─── decide() — the only piece of trading logic you write ─────────────────────
//
// Pure function. Receives the live snapshot + your bookkeeping state, returns
// ONE intended action. The runner below applies it via the Fasol API.
//
// Inputs:
//   ctx.coin            — full CoinStat from /coin/{ca}/stats
//   ctx.position        — { coin_address, balance, entry_price_usd, ... } | null
//   ctx.runtime_min     — minutes since the script started
//   ctx.last_action_ts  — Date.now() of last buy/sell/cancel, or null
//
// Output (one of):
//   { kind: "wait" }
//   { kind: "buy",    trigger_price: "0.0000110", amount_sol: "0.1" }    // limit_buy
//   { kind: "tp_sl",  take_profit_p: "40", stop_loss_p: "-20" }          // arm exits
//   { kind: "sell",   sell_p: "100", reason: "vol_collapse" }            // market sell
//   { kind: "stop",   reason: "time_limit" }                             // exit script
function decide(ctx) {
  const { coin, position, runtime_min } = ctx;

  // Hard time limit — always surface this first.
  if (runtime_min >= CONFIG.max_runtime_minutes) {
    return { kind: "stop", reason: "time_limit" };
  }

  const price = Number(coin.price_usd);
  const vol5m = Number(coin.vol_5m);

  // No position yet — wait for the dip.
  if (!position) {
    if (price <= CONFIG.entry_price_usd) {
      return {
        kind: "buy",
        trigger_price: String(CONFIG.entry_price_usd),
        amount_sol: String(CONFIG.amount_sol),
      };
    }
    return { kind: "wait" };
  }

  // Have a position — make sure exits are armed.
  // (We arm them once after the buy fills; the runner remembers.)
  if (!ctx.exits_armed) {
    return {
      kind: "tp_sl",
      take_profit_p: String(CONFIG.take_profit_p),
      stop_loss_p:   String(CONFIG.stop_loss_p),
    };
  }

  // Emergency exit: liquidity / volume collapse.
  if (vol5m < CONFIG.vol_5m_floor_usd) {
    return { kind: "sell", sell_p: "100", reason: "vol_collapsed" };
  }

  return { kind: "wait" };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ─── Runner — generic. You shouldn't need to edit below this line. ────────────
// ═══════════════════════════════════════════════════════════════════════════════

let stopRequested = false;
let exitsArmed = false;
let lastActionTs = null;
const startedAt = Date.now();

const log = (event, fields = {}) => {
  // Single JSON line per log entry — easy for the agent to tail/grep.
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(),
    runtime_min: Math.round((Date.now() - startedAt) / 60_000 * 10) / 10,
    event,
    ...fields,
  }) + "\n");
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wraps an api() call in 429 back-off + structured logging.
const safeCall = async (label, fn) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err.status === 429) {
        const wait = (err.retryAfter ?? 60) * 1000;
        log("rate_limited", { call: label, wait_ms: wait, attempt });
        await sleep(wait);
        continue;
      }
      log("api_error", { call: label, status: err.status, message: err.message, attempt });
      if (attempt === 2) throw err;
      await sleep(2000 * (attempt + 1));
    }
  }
};

const findPosition = (positions) =>
  (positions || []).find((p) => p.coin_address === CONFIG.coin_address) || null;

const applyAction = async (action) => {
  switch (action.kind) {
    case "wait":
      return;

    case "buy": {
      log("place_buy", { trigger_price: action.trigger_price, amount_sol: action.amount_sol });
      await safeCall("place_order/limit_buy", () =>
        api("POST", "/orders", {
          body: {
            type: "limit_buy",
            coin_address: CONFIG.coin_address,
            trigger_price: action.trigger_price,
            amount_sol: action.amount_sol,
          },
        }),
      );
      lastActionTs = Date.now();
      return;
    }

    case "tp_sl": {
      log("arm_exits", { tp_p: action.take_profit_p, sl_p: action.stop_loss_p });
      await safeCall("place_order/take_profit", () =>
        api("POST", "/orders", {
          body: {
            type: "take_profit",
            coin_address: CONFIG.coin_address,
            trigger_p: action.take_profit_p,
            sell_p: "100",
          },
        }),
      );
      await safeCall("place_order/stop_loss", () =>
        api("POST", "/orders", {
          body: {
            type: "stop_loss",
            coin_address: CONFIG.coin_address,
            trigger_p: action.stop_loss_p,
            sell_p: "100",
          },
        }),
      );
      exitsArmed = true;
      lastActionTs = Date.now();
      return;
    }

    case "sell": {
      log("market_sell", { sell_p: action.sell_p, reason: action.reason });
      // Use limit_sell at trigger 0 = sell at any price (i.e. market).
      await safeCall("place_order/market_sell", () =>
        api("POST", "/orders", {
          body: {
            type: "limit_sell",
            coin_address: CONFIG.coin_address,
            trigger_price: "0",
            sell_p: action.sell_p,
          },
        }),
      );
      lastActionTs = Date.now();
      return;
    }

    case "stop": {
      log("strategy_stop", { reason: action.reason });
      stopRequested = true;
      return;
    }

    default:
      log("unknown_action", { action });
  }
};

const tick = async (i) => {
  const coinRes = await safeCall("coin_stats", () =>
    api("GET", `/coin/${CONFIG.coin_address}/stats`),
  );
  const positionsRes = await safeCall("list_positions", () =>
    api("GET", "/positions"),
  );

  const coin = coinRes?.data;
  const position = findPosition(positionsRes?.data);
  if (!coin) {
    log("coin_not_found", { iteration: i });
    return;
  }

  const ctx = {
    coin,
    position,
    runtime_min: (Date.now() - startedAt) / 60_000,
    last_action_ts: lastActionTs,
    exits_armed: exitsArmed,
  };
  const action = decide(ctx);

  log("tick", {
    iteration: i,
    price_usd: coin.price_usd,
    mc: coin.mc,
    liq: coin.liq,
    vol_5m: coin.vol_5m,
    has_position: !!position,
    decision: action.kind,
    decision_reason: action.reason,
  });

  await applyAction(action);
};

// Graceful shutdown — Ctrl-C in foreground, kill -TERM in background.
process.on("SIGINT", () => { log("signal", { name: "SIGINT" }); stopRequested = true; });
process.on("SIGTERM", () => { log("signal", { name: "SIGTERM" }); stopRequested = true; });

(async () => {
  log("strategy_start", { config: CONFIG });
  for (let i = 0; i < CONFIG.max_iterations && !stopRequested; i++) {
    try {
      await tick(i);
    } catch (err) {
      log("tick_error", { iteration: i, message: err?.message });
    }
    if (stopRequested) break;
    await sleep(CONFIG.poll_seconds * 1000);
  }
  log("strategy_end", { iterations_done: "see_above", reason: stopRequested ? "stopped" : "max_iterations" });
  cliLog.ok("strategy ended");
})().catch((err) => {
  log("fatal", { message: err?.message });
  process.exit(1);
});
