#!/usr/bin/env node
// place-order.mjs — create a new order (limit_buy / limit_sell / take_profit / stop_loss / trailing).
//
// Usage:
//   node place-order.mjs limit_buy   --coin <addr> --trigger-price 0.0000123 --amount-sol 0.1
//   node place-order.mjs limit_sell  --coin <addr> --trigger-price 0.0000200 --sell-p 100
//   node place-order.mjs take_profit --coin <addr> --trigger-p 50  --sell-p 100
//   node place-order.mjs stop_loss   --coin <addr> --trigger-p -25 --sell-p 100
//   node place-order.mjs trailing    --coin <addr> --trailing-p 10 --sell-p 100 --activation-p 0
//
// All numeric flag values are kept as STRINGS — the API expects strings to
// preserve precision on lamport-scale and small-decimal-price values.

import { api, log, printJson, assertSolanaAddress, parseArgs } from "./lib/api.mjs";

const VALID_TYPES = ["limit_buy", "limit_sell", "take_profit", "stop_loss", "trailing"];

const { flags, positional } = parseArgs(process.argv.slice(2));
const type = positional[0];

if (!type || !VALID_TYPES.includes(type)) {
  log.err(`Usage: node place-order.mjs <${VALID_TYPES.join("|")}> --coin <addr> ...`);
  process.exit(2);
}

const coin = flags.coin;
if (!coin) {
  log.err("--coin <coin_address> is required");
  process.exit(2);
}

try {
  assertSolanaAddress(coin, "coin_address");
} catch (err) {
  log.err(err.message);
  process.exit(2);
}

// Build the body per type. Each variant validates its own required fields so
// the agent gets a clear error before the request hits the network.
const body = { type, coin_address: coin };
const required = (key, flagName) => {
  const v = flags[flagName];
  if (v === undefined || v === true || v === "") {
    log.err(`--${flagName} is required for ${type}`);
    process.exit(2);
  }
  body[key] = String(v);
};

switch (type) {
  case "limit_buy":
    required("trigger_price", "trigger-price");
    required("amount_sol", "amount-sol");
    break;
  case "limit_sell":
    required("trigger_price", "trigger-price");
    required("sell_p", "sell-p");
    break;
  case "take_profit":
  case "stop_loss":
    required("trigger_p", "trigger-p");
    required("sell_p", "sell-p");
    break;
  case "trailing":
    required("trailing_p", "trailing-p");
    required("sell_p", "sell-p");
    if (flags["activation-p"] !== undefined) {
      body.activation_p = String(flags["activation-p"]);
    }
    break;
}

try {
  const res = await api("POST", "/orders", { body });
  printJson(res.data);
  log.ok(`✓ order created: ${res.data?.id ?? "(no id returned)"}`);
} catch (err) {
  log.err(`place-order failed: ${err.message}`);
  process.exit(1);
}
