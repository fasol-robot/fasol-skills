#!/usr/bin/env node
// coin-stats.mjs — fetch full CoinStat for a coin.
//
// Usage:
//   node coin-stats.mjs <coin_address>

import { api, log, printJson, assertSolanaAddress, parseArgs } from "./lib/api.mjs";

const { positional } = parseArgs(process.argv.slice(2));
const coin = positional[0];

if (!coin) {
  log.err("Usage: node coin-stats.mjs <coin_address>");
  process.exit(2);
}

try {
  assertSolanaAddress(coin, "coin_address");
  const res = await api("GET", `/coin/${coin}/stats`);
  printJson(res.data);
} catch (err) {
  log.err(`coin-stats failed: ${err.message}`);
  process.exit(1);
}
