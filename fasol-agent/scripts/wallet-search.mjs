#!/usr/bin/env node
// wallet-search.mjs — discover Solana wallets by profit / activity / behavior.
//
// Usage:
//   node wallet-search.mjs '<json-body>'
//
// Example:
//   node wallet-search.mjs '{"filters":{"min_total_profit_usd":50000,"min_win_rate":0.6,"last_active_within_sec":3600,"min_trades_24h":20},"limit":10}'

import { api, log, printJson } from "./lib/api.mjs";

const raw = process.argv[2];
if (!raw) {
  log.err("usage: node wallet-search.mjs '<json-body>'");
  log.err('see SKILL.md "Wallet discovery" for the filter whitelist.');
  process.exit(2);
}

let body;
try {
  body = JSON.parse(raw);
} catch (err) {
  log.err(`invalid JSON body: ${err.message}`);
  process.exit(2);
}

try {
  const res = await api("POST", "/wallet_search", { body });
  printJson(res.data);
} catch (err) {
  log.err(`wallet-search failed: ${err.message}`);
  process.exit(1);
}
