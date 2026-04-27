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

const BASE_URL = process.env.FASOL_API_BASE_URL || "https://api.fasol.trade/trading_bot/agent";
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
 * Subscribe to a coin's live price stream. Async generator that yields events:
 *   { event: "ready",     data: {...} }     once on connect
 *   { event: "price",     data: {...} }     on each price tick
 *   { event: "heartbeat", data: null  }     ignored upstream — we filter out
 *
 * Iteration ends only on terminal HTTP error or when caller breaks the loop.
 */
export async function* subscribeCoinPriceStream(coinAddress, { signal } = {}) {
  let backoff = BACKOFF_INITIAL_MS;

  while (!signal?.aborted) {
    let response;
    try {
      response = await fetch(`${BASE_URL}/coin/${coinAddress}/stream`, {
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
    // Connected — reset backoff for the next reconnect cycle.
    backoff = BACKOFF_INITIAL_MS;

    if (!response.body) {
      throw new Error("no response body — runtime missing fetch streaming");
    }

    // Read the stream as text and split on the SSE event boundary `\n\n`.
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

    // Connection dropped — wait then reconnect.
    if (signal?.aborted) return;
    await sleep(backoff, undefined, { signal });
    backoff = Math.min(BACKOFF_MAX_MS, backoff * 2);
  }
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
