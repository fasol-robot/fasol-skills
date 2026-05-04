#!/usr/bin/env node
/**
 * copy-trader.mjs — production-ready template for mirror-trading the user's
 * tracked wallets.
 *
 * The agent picks source wallets via /wallet_search, adds them to
 * /tracked_wallets, then runs this script in the background. Every buy from a
 * source wallet that passes the entry filter is mirrored at our size; the
 * matching sell is mirrored back. Each wallet earns its own size from a tier
 * ladder — winners compound, losers get cut.
 *
 * Why this template exists: the toy "mirror their buys" loop in the SKILL
 * loses money on a real account. The 10-iteration deltas baked in here came
 * from a live $40+ test:
 *
 *   1.  Force-reconnect SSE every 4 min (otherwise events stop silently)
 *   2.  Check `/swap` body errors (200 OK with `{error:"slip"}` is a failure)
 *   3.  Drop phantom positions on `no_coin_balance` sells
 *   4.  first_buy + low-pnl buy_more filter (avoid late entries)
 *   5.  Exit on their FIRST sell (not just sell_all)
 *   6.  Per-wallet adaptive sizing (one rug shouldn't sink the bot)
 *   7.  Auto-disable losers (0 wins / N losses)
 *   8.  Fee floor — never trade below 0.005 SOL
 *   9.  trade_audit JSONL — diagnose slippage gaps offline
 *
 * Usage (after agent customises CONFIG below):
 *
 *   export FASOL_API_KEY="fsl_live_..."
 *   export FASOL_API_BASE_URL="https://api.dev-1.mymadrobot.com/trading_bot/agent"
 *   node copy-trader.mjs > copy-trader.log 2>&1 &
 *   pkill -f copy-trader.mjs   # stop
 *
 * Stop conditions: SIGINT/SIGTERM (clean shutdown), `MAX_LOSS_SOL` hard kill.
 *
 * Logs:
 *   - copy-trader.log         — one JSON object per cycle event
 *   - trades_audit.jsonl      — one row per closed cycle, full audit data
 */

import { api, swap, log as cliLog } from "./lib/api.mjs";
import { subscribeTrackedWalletTradeStream, withReconnect } from "./lib/sse.mjs";
import { appendFileSync } from "node:fs";

// ─── CONFIG ───────────────────────────────────────────────────────────────
// The agent edits these for the strategy. Defaults reflect the live-tuned
// values from the audit run; conservative-ish.

const CONFIG = {
  // Source wallets — one of:
  //   - explicit list (the agent adds them to /tracked_wallets first)
  //   - empty array → mirror EVERY tracked wallet (server-filtered to the
  //     authenticated user's list; client-side narrows by wallet still active)
  SOURCE_WALLETS: process.env.SOURCE_WALLETS
    ? process.env.SOURCE_WALLETS.split(",").map(s => s.trim()).filter(Boolean)
    : [],

  // Sizing tier ladder — each wallet is index'd into this. Pure additive.
  // Tier 0 floor (0.001) exists for "downgraded" wallets only — fees swallow
  // tier 0 if used as a starting size. Don't start new wallets below 0.005.
  SIZE_TIERS: [0.001, 0.002, 0.005, 0.01, 0.02, 0.03, 0.05, 0.07, 0.1],
  WALLET_START_TIER: 2,            // SIZE_TIERS[2] = 0.005 SOL
  WALLET_TIER_STEP_SOL: 0.005,     // ±this much wallet pnl since last move → ±1 tier

  // Risk controls
  MAX_POSITIONS:        4,
  MAX_LOSS_SOL:         0.2,       // hard kill — bot exits when cumul ≤ -this
  MAX_HOLD_SEC:         1800,      // 30 min force-exit if their sell never came

  // Auto-disable wallets that go cold
  DISABLE_AFTER_LOSS_SOL: 0.05,    // wallet_pnl ≤ -this AND cycles ≥ DISABLE_MIN_CYCLES
  DISABLE_MIN_CYCLES:     5,
  DISABLE_ZERO_WIN_CYCLES: 5,      // 0 wins after this many cycles → disable

  // Mirror filter: when to enter on a SSE buy event
  // - first_buy           — always
  // - buy_more && pnl <= BUY_MORE_MAX_PNL — soft filter, catches mid-cycle
  // - anything else       — drop (late entry on accumulated peak)
  BUY_MORE_MAX_PNL: 10,            // % — their pnl_percent at the buy event

  // Slippage — copy-trading needs to fill at any price (default 15% rejects
  // most fast pumps). Set "100" to accept worst-case.
  SLIPPAGE_P: "100",

  // Optional: only mirror pump.fun coins. The /tracked_wallets feed already
  // emits everything; this is a safety filter.
  PF_ONLY: process.env.PF_ONLY === "true",

  // SSE reconnect every N ms — empirical workaround for stale connections.
  SSE_RECONNECT_MS: 4 * 60_000,

  // Audit log file (appended). Empty string disables.
  AUDIT_FILE: "trades_audit.jsonl",

  DRY_RUN: process.env.DRY_RUN === "true",
};

// ─── STATE ────────────────────────────────────────────────────────────────

const positions = {};                    // coin -> { source_wallet, entry_ts, entry_size_sol, their_buy_* }
const pendingClosures = [];              // closed positions waiting for reconcile
const walletStats = {};                  // wallet -> { cycles, wins, losses, pnl_sol, sizeIdx, sizeBaseline }
const disabledWallets = new Set();
const coinIsPfCache = {};
let cumulativeRealisedSol = 0;
let cyclesCompleted = 0;
let myAgentId = null;

const log = (level, event, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...extra }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getOrInitStats(wallet) {
  if (!walletStats[wallet]) {
    walletStats[wallet] = {
      cycles: 0, wins: 0, losses: 0, pnl_sol: 0,
      sizeIdx: CONFIG.WALLET_START_TIER,
      sizeBaseline: 0,
    };
  }
  return walletStats[wallet];
}

function walletSize(wallet) {
  return CONFIG.SIZE_TIERS[getOrInitStats(wallet).sizeIdx];
}

// ─── HELPERS ──────────────────────────────────────────────────────────────

async function isPfCoin(coin) {
  if (!CONFIG.PF_ONLY) return true;
  if (coin in coinIsPfCache) return coinIsPfCache[coin];
  try {
    const r = await api("GET", `/coin/${coin}/stats`);
    const isPf = r.data.launchpad === "pf";
    coinIsPfCache[coin] = isPf;
    return isPf;
  } catch { return false; }
}

async function placeBuy(coin, wallet) {
  const size = walletSize(wallet);
  log("info", "place_buy", { coin, amount_sol: size, wallet: wallet.slice(0, 8) });
  if (CONFIG.DRY_RUN) return { ok: true, dry: true };
  // `swap()` throws on body errors (slip / no_coin_balance / coin_not_found).
  return await swap({
    direction: "buy",
    coin_address: coin,
    amount_sol: String(size),
    slippage_p: CONFIG.SLIPPAGE_P,
  });
}

async function placeSell(coin, reason) {
  log("info", "place_sell", { coin, reason });
  if (CONFIG.DRY_RUN) return { ok: true, dry: true };
  return await swap({
    direction: "sell",
    coin_address: coin,
    sell_p: "100",
    slippage_p: CONFIG.SLIPPAGE_P,
  });
}

// ─── CORE LOOP ─────────────────────────────────────────────────────────────

async function processBuyTrade(t) {
  if (disabledWallets.has(t.wallet)) {
    return log("info", "skip_disabled_wallet", { coin: t.coin_address, wallet: t.wallet.slice(0, 8) });
  }
  if (CONFIG.SOURCE_WALLETS.length > 0 && !CONFIG.SOURCE_WALLETS.includes(t.wallet)) return;
  if (positions[t.coin_address]) return log("info", "skip_already_holding", { coin: t.coin_address });
  if (Object.keys(positions).length >= CONFIG.MAX_POSITIONS) {
    return log("info", "skip_max_positions", { coin: t.coin_address });
  }
  if (CONFIG.PF_ONLY && !(await isPfCoin(t.coin_address))) {
    return log("info", "skip_non_pf", { coin: t.coin_address });
  }

  // Entry filter: first_buy always; buy_more only if their pnl is still small
  // (they're near entry, not riding an accumulated peak).
  if (t.trade_type && t.trade_type !== "first_buy") {
    const pnl = typeof t.pnl_percent === "number" ? t.pnl_percent : Infinity;
    if (pnl > CONFIG.BUY_MORE_MAX_PNL) {
      return log("info", "skip_late_entry", {
        coin: t.coin_address, source: t.wallet.slice(0, 8),
        trade_type: t.trade_type, their_pnl: pnl, threshold: CONFIG.BUY_MORE_MAX_PNL,
      });
    }
  }

  log("info", "mirror_buy", {
    coin: t.coin_address, symbol: t.symbol,
    source: `${t.wallet.slice(0, 6)}…${t.wallet.slice(-4)}`,
    their_sol: t.amount_sol, mc: t.mc, trade_type: t.trade_type,
  });
  try {
    await placeBuy(t.coin_address, t.wallet);
    positions[t.coin_address] = {
      entry_ts: Date.now(),
      source_wallet: t.wallet,
      symbol: t.symbol,
      entry_size_sol: walletSize(t.wallet),
      their_buy_ts: t.last_tx_at,
      their_buy_amount_sol: t.amount_sol,
      their_buy_pnl_pct: t.pnl_percent,
      their_buy_trade_type: t.trade_type,
    };
  } catch (e) {
    log("error", "buy_failed", { coin: t.coin_address, err: e.message });
  }
}

async function processSellTrade(t) {
  const pos = positions[t.coin_address];
  if (!pos) return;
  // Exit on ANY sell (don't wait for sell_all). Many wallets ride a tail.
  log("info", "mirror_sell", {
    coin: t.coin_address, symbol: t.symbol,
    source: `${t.wallet.slice(0, 6)}…${t.wallet.slice(-4)}`,
    their_trade_type: t.trade_type, their_pnl_pct: t.pnl_percent,
  });
  try {
    await placeSell(t.coin_address, t.trade_type || "tracked_sell");
    delete positions[t.coin_address];
    pendingClosures.push({
      coin: t.coin_address, entry_ts: pos.entry_ts, sell_ts: Date.now(),
      symbol: pos.symbol, source_wallet: pos.source_wallet,
      entry_size_sol: pos.entry_size_sol,
      their_buy_ts: pos.their_buy_ts,
      their_buy_amount_sol: pos.their_buy_amount_sol,
      their_buy_pnl_pct: pos.their_buy_pnl_pct,
      their_buy_trade_type: pos.their_buy_trade_type,
      their_sell_ts: t.last_tx_at,
      their_sell_amount_sol: t.amount_sol,
      their_sell_pnl_pct: t.pnl_percent,
      their_sell_trade_type: t.trade_type,
    });
  } catch (e) {
    log("error", "sell_failed", { coin: t.coin_address, err: e.message });
    // The unambiguous "we don't actually hold it" signal — clear local state
    // so a future first_buy on the same coin can re-enter.
    if (e.swapError === "no_coin_balance") {
      log("warn", "drop_phantom_position", { coin: t.coin_address });
      delete positions[t.coin_address];
    }
  }
}

// Backstop: hard time-stop in case the source wallet bag-holds.
async function backstop() {
  while (true) {
    await sleep(5_000);
    for (const [coin, pos] of Object.entries(positions)) {
      const ageSec = (Date.now() - pos.entry_ts) / 1000;
      if (ageSec > CONFIG.MAX_HOLD_SEC) {
        log("warn", "backstop_time_exit", { coin, age_sec: Math.round(ageSec) });
        try { await placeSell(coin, "time_limit"); } catch (e) { /* surfaced by reconcile */ }
        delete positions[coin];
        pendingClosures.push({
          coin, entry_ts: pos.entry_ts, sell_ts: Date.now(),
          symbol: pos.symbol, source_wallet: pos.source_wallet,
          entry_size_sol: pos.entry_size_sol,
          their_buy_ts: pos.their_buy_ts,
          their_buy_pnl_pct: pos.their_buy_pnl_pct,
        });
      }
    }
  }
}

// Reconcile pending closures: pull our actual trades, compute pnl, update
// per-wallet stats + size tier, write audit row, check kill switch.
async function reconcile() {
  while (true) {
    await sleep(30_000);
    if (pendingClosures.length === 0) continue;
    let positionsList;
    try {
      positionsList = (await api("GET", "/positions")).data;
    } catch (e) { log("warn", "reconcile_positions_fail", { err: e.message }); continue; }
    const heldCoins = new Set(positionsList.map(p => p.coin_address));

    for (let i = pendingClosures.length - 1; i >= 0; i--) {
      const pc = pendingClosures[i];
      if (heldCoins.has(pc.coin)) {
        // Still held — wait. After 60s assume the sell didn't settle.
        if (Date.now() - pc.sell_ts > 60_000) {
          log("warn", "sell_unsettled", { coin: pc.coin });
          pendingClosures.splice(i, 1);
        }
        continue;
      }

      let mine;
      try {
        const r = await api("GET", `/trades?coin_address=${pc.coin}&from_ts=${Math.floor(pc.entry_ts/1000)*1000 - 5000}&limit=20`);
        mine = (r.data || []).filter(t => t.tx_type === "agent_swap" && !t.error_text);
      } catch (e) { log("warn", "reconcile_trades_fail", { coin: pc.coin, err: e.message }); continue; }

      let solIn = 0, solOut = 0, fees = 0;
      let myBuyTs = null, myBuyPriceUsd = null, mySellTs = null, mySellPriceUsd = null;
      for (const t of mine) {
        const sol = parseFloat(t.amount_sol);
        fees += parseFloat(t.fees_sol || "0") + parseFloat(t.fasol_fee_sol || "0");
        if (t.direction === "buy") { solIn += sol; myBuyTs ??= t.ts; myBuyPriceUsd ??= t.price_usd; }
        else if (t.direction === "sell") { solOut += sol; mySellTs = t.ts; mySellPriceUsd = t.price_usd; }
      }
      const pnl = solOut - solIn - fees;
      cumulativeRealisedSol += pnl;
      cyclesCompleted++;

      // Per-wallet stats + adaptive size
      const stats = getOrInitStats(pc.source_wallet);
      stats.cycles++;
      stats.pnl_sol += pnl;
      pnl > 0 ? stats.wins++ : stats.losses++;

      const walletDelta = stats.pnl_sol - stats.sizeBaseline;
      if (walletDelta >= CONFIG.WALLET_TIER_STEP_SOL && stats.sizeIdx < CONFIG.SIZE_TIERS.length - 1) {
        stats.sizeIdx++;
        stats.sizeBaseline = stats.pnl_sol;
        log("info", "wallet_size_up", {
          wallet: pc.source_wallet, new_size_sol: CONFIG.SIZE_TIERS[stats.sizeIdx],
          wallet_pnl: stats.pnl_sol.toFixed(8),
        });
      } else if (walletDelta <= -CONFIG.WALLET_TIER_STEP_SOL && stats.sizeIdx > 0) {
        stats.sizeIdx--;
        stats.sizeBaseline = stats.pnl_sol;
        log("warn", "wallet_size_down", {
          wallet: pc.source_wallet, new_size_sol: CONFIG.SIZE_TIERS[stats.sizeIdx],
          wallet_pnl: stats.pnl_sol.toFixed(8),
        });
      }

      log("info", "cycle_closed", {
        coin: pc.coin, symbol: pc.symbol,
        source: pc.source_wallet?.slice(0, 8),
        cycle_pnl_sol: pnl.toFixed(8),
        wallet_pnl_sol: stats.pnl_sol.toFixed(8),
        wallet_record: `${stats.wins}W/${stats.losses}L (${stats.cycles})`,
        wallet_size_sol: CONFIG.SIZE_TIERS[stats.sizeIdx],
        cumulative_pnl_sol: cumulativeRealisedSol.toFixed(8),
        cycles: cyclesCompleted,
      });

      // Auto-disable: pure-loser pattern OR cumulative loss past threshold
      const overLoss = stats.cycles >= CONFIG.DISABLE_MIN_CYCLES &&
                       stats.pnl_sol <= -CONFIG.DISABLE_AFTER_LOSS_SOL;
      const zeroWinStreak = stats.wins === 0 && stats.cycles >= CONFIG.DISABLE_ZERO_WIN_CYCLES;
      if (overLoss || zeroWinStreak) {
        disabledWallets.add(pc.source_wallet);
        log("warn", "wallet_disabled", {
          wallet: pc.source_wallet, cycles: stats.cycles, wins: stats.wins, losses: stats.losses,
          total_pnl_sol: stats.pnl_sol.toFixed(8),
          reason: zeroWinStreak ? "0 wins / N losses" : `cumulative loss ≤ -${CONFIG.DISABLE_AFTER_LOSS_SOL}`,
        });
      }

      // Audit row — full picture for offline analysis
      if (CONFIG.AUDIT_FILE) {
        try {
          appendFileSync(CONFIG.AUDIT_FILE, JSON.stringify({
            ts: new Date().toISOString(),
            coin: pc.coin, symbol: pc.symbol, source_wallet: pc.source_wallet,
            entry_size_sol: pc.entry_size_sol,
            cycle_pnl_sol: pnl,
            our_pnl_pct: pc.entry_size_sol ? (pnl / pc.entry_size_sol * 100) : null,
            our_sol_in: solIn, our_sol_out: solOut, our_fees_sol: fees,
            our_buy_ts: myBuyTs, our_buy_price_usd: myBuyPriceUsd,
            our_sell_ts: mySellTs, our_sell_price_usd: mySellPriceUsd,
            their_buy_ts: pc.their_buy_ts, their_buy_amount_sol: pc.their_buy_amount_sol,
            their_buy_pnl_pct: pc.their_buy_pnl_pct, their_buy_trade_type: pc.their_buy_trade_type,
            their_sell_ts: pc.their_sell_ts, their_sell_amount_sol: pc.their_sell_amount_sol,
            their_sell_pnl_pct: pc.their_sell_pnl_pct, their_sell_trade_type: pc.their_sell_trade_type,
            buy_lag_ms: (myBuyTs && pc.their_buy_ts) ? (myBuyTs - pc.their_buy_ts) : null,
            sell_lag_ms: (mySellTs && pc.their_sell_ts) ? (mySellTs - pc.their_sell_ts) : null,
            hold_ms_ours: (mySellTs && myBuyTs) ? (mySellTs - myBuyTs) : null,
          }) + "\n");
        } catch { /* ignore */ }
      }

      pendingClosures.splice(i, 1);

      if (cumulativeRealisedSol <= -CONFIG.MAX_LOSS_SOL) {
        log("fatal", "max_loss_reached", { cumulative: cumulativeRealisedSol.toFixed(8) });
        process.exit(0);
      }
    }
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────

const onShutdown = () => {
  log("info", "shutdown", {
    cycles: cyclesCompleted,
    cumulative_pnl_sol: cumulativeRealisedSol.toFixed(8),
  });
  process.exit(0);
};
process.on("SIGINT", onShutdown);
process.on("SIGTERM", onShutdown);

async function main() {
  const scope = await api("GET", "/scope");
  myAgentId = scope.data.agent_id;
  const tracked = await api("GET", "/tracked_wallets");
  log("info", "start", {
    agent_id: myAgentId,
    tracked_count: tracked.data.length,
    source_wallets: CONFIG.SOURCE_WALLETS.length || "(all tracked)",
    config: { ...CONFIG, SIZE_TIERS: undefined },  // don't echo array bloat
  });

  // Background workers
  backstop().catch(e => log("error", "backstop_died", { err: e.message }));
  reconcile().catch(e => log("error", "reconcile_died", { err: e.message }));

  // Main SSE loop with auto-reconnect (workaround for stale connections)
  const stream = withReconnect(
    (signal) => subscribeTrackedWalletTradeStream({ signal }),
    { intervalMs: CONFIG.SSE_RECONNECT_MS },
  );
  for await (const evt of stream) {
    if (evt.event === "ready") { log("info", "stream_ready", evt.data); continue; }
    if (evt.event !== "tracked_trade" || evt.data?.type !== "tracked_trade") continue;
    const t = evt.data.trade;
    if (!t) continue;

    // Drop stale events (tracked stream replays last_tx_at which can be older
    // than the SSE delivery clock). 30s window matches our reaction budget.
    const eventTs = t.last_tx_at || t.first_tx_at;
    if (eventTs && Date.now() - eventTs > 30_000) continue;

    if (t.buy_sell === "buy") await processBuyTrade(t);
    else if (t.buy_sell === "sell") await processSellTrade(t);
  }
}

main().catch(e => { log("fatal", "main_died", { err: e.message }); process.exit(1); });
