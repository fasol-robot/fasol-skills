// Tiny Server-Sent-Events consumer for Node 18+. No deps — uses native fetch
// + Web Streams. Yields one parsed event per `for await`.
//
// Usage in a strategy script:
//
//   import { subscribeCoinPriceStream } from "./lib/sse.mjs";
//
//   for await (const evt of subscribeCoinPriceStream(coinAddress)) {
//     if (evt.event === "price") {
//       handleTick(evt.data);
//     }
//   }
//
// The generator handles auto-reconnect with backoff (the SSE spec says clients
// should reconnect — we do, with capped exponential delay). On terminal errors
// (auth failure, missing scope) it stops without retrying.

import { setTimeout as sleep } from "timers/promises";

// FASOL_API_BASE_URL points at /trading_bot/agent on the API process. The SSE
// stream lives on the WS process behind nginx at /agent_stream/* on the same
// host. We derive the stream base from the API base by stripping the suffix.
// Override explicitly via FASOL_STREAM_BASE_URL if your deploy splits hosts.
const API_BASE = process.env.FASOL_API_BASE_URL || "https://api.fasol.trade/trading_bot/agent";
const STREAM_BASE = process.env.FASOL_STREAM_BASE_URL ||
  API_BASE.replace(/\/trading_bot\/agent\/?$/, "") + "/agent_stream";
const KEY = process.env.FASOL_API_KEY;

if (!KEY) {
  console.error("ERROR: FASOL_API_KEY env var is not set.");
  process.exit(2);
}

// Reconnect policy. Don't retry on auth/scope errors — they won't recover
// without manual intervention.
const TERMINAL_STATUS = new Set([400, 401, 403, 404]);
const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/**
 * Generic SSE consumer. Async generator yielding `{ event, data }` blocks.
 * Auto-reconnect with capped exponential backoff on transient HTTP / network
 * errors. Throws on terminal codes (400 / 401 / 403 / 404).
 */
async function* streamSSE(url, { signal } = {}) {
  let backoff = BACKOFF_INITIAL_MS;

  while (!signal?.aborted) {
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${KEY}`,
          Accept: "text/event-stream",
        },
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return;
      console.error(`[sse] fetch failed: ${err.message}; retry in ${backoff}ms`);
      await sleep(backoff, undefined, { signal });
      backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (TERMINAL_STATUS.has(response.status)) {
        throw new Error(`stream terminal error ${response.status}: ${text}`);
      }
      console.error(`[sse] http ${response.status}: ${text}; retry in ${backoff}ms`);
      await sleep(backoff, undefined, { signal });
      backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
      continue;
    }
    backoff = BACKOFF_INITIAL_MS;

    if (!response.body) {
      throw new Error("no response body — runtime missing fetch streaming");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        let nl;
        while ((nl = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (raw.startsWith(":")) continue; // comment / heartbeat — ignore
          const ev = parseSseBlock(raw);
          if (ev) yield ev;
        }
      }
    } catch (err) {
      if (signal?.aborted) return;
      console.error(`[sse] read error: ${err.message}; reconnecting in ${backoff}ms`);
    } finally {
      try { reader.cancel(); } catch {}
    }

    if (signal?.aborted) return;
    await sleep(backoff, undefined, { signal });
    backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
  }
}

/**
 * Subscribe to one coin's live price stream. Yields:
 *   { event: "ready", data: {...} }     once on connect
 *   { event: "price", data: {...} }     on each price tick
 */
export function subscribeCoinPriceStream(coinAddress, opts = {}) {
  return streamSSE(`${STREAM_BASE}/coin/${coinAddress}`, opts);
}

/**
 * Subscribe to live tx-status events for the authenticated wallet. Yields:
 *   { event: "ready", data: {...} }     once on connect
 *   { event: "tx",    data: {...} }     on each NotifyTxEvent
 *
 * Optional `coin_address` narrows to one coin server-side.
 */
export function subscribeTxStream({ coin_address, signal } = {}) {
  const url = coin_address
    ? `${STREAM_BASE}/tx?coin_address=${encodeURIComponent(coin_address)}`
    : `${STREAM_BASE}/tx`;
  return streamSSE(url, { signal });
}

/**
 * Subscribe to every swap on a coin (any wallet) — for live volume / VWAP /
 * order-flow indicators. Yields:
 *   { event: "ready", data: {...} }     once on connect
 *   { event: "trade", data: { coin_address, trade } }  on each swap
 *
 * `trade` is the LiveTrade shape used by the coin terminal:
 * { wallet, buy_sell, amount_sol, amount_coin, hash, date, price_usd, ... }
 */
export function subscribeCoinTradeStream(coinAddress, opts = {}) {
  return streamSSE(`${STREAM_BASE}/coin/${coinAddress}/trades`, opts);
}

/**
 * Subscribe to live trades from the user's tracked wallets. Yields:
 *   { event: "ready",          data: {...} }     once on connect
 *   { event: "tracked_trade",  data: { user_id, trade } }  on each swap
 *
 * `trade` is the same LiveTrade shape — useful when you want the agent to
 * react to what specific wallets the user is following are doing (smart
 * money, devs, etc.).
 */
export function subscribeTrackedWalletTradeStream(opts = {}) {
  return streamSSE(`${STREAM_BASE}/tracked_wallet_trades`, opts);
}

// Parse one SSE block (already split on \n\n). Returns { event, data } or null.
function parseSseBlock(block) {
  let event = "message";
  const dataLines = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  let data;
  try { data = JSON.parse(raw); } catch { data = raw; }
  return { event, data };
}
