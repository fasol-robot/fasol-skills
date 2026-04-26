#!/usr/bin/env node
// cancel-order.mjs — cancel an active order by id.
//
// Usage:
//   node cancel-order.mjs <order_id> --coin <coin_address>

import { api, log, printJson, assertSolanaAddress, parseArgs } from "./lib/api.mjs";

const { flags, positional } = parseArgs(process.argv.slice(2));
const orderId = positional[0];
const coin = flags.coin;

if (!orderId) {
  log.err("Usage: node cancel-order.mjs <order_id> --coin <coin_address>");
  process.exit(2);
}
if (!coin) {
  log.err("--coin <coin_address> is required");
  process.exit(2);
}

try {
  assertSolanaAddress(coin, "coin_address");
  const res = await api("DELETE", `/orders/${encodeURIComponent(orderId)}`, {
    body: { coin_address: coin },
  });
  printJson(res.data);
  log.ok(`✓ order cancelled: ${orderId}`);
} catch (err) {
  log.err(`cancel-order failed: ${err.message}`);
  process.exit(1);
}
