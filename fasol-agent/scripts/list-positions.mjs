#!/usr/bin/env node
// list-positions.mjs — print all open positions for the user's primary wallet.
//
// Usage:
//   node list-positions.mjs

import { api, log, printJson } from "./lib/api.mjs";

try {
  const res = await api("GET", "/positions");
  printJson(res.data);
} catch (err) {
  log.err(`list-positions failed: ${err.message}`);
  process.exit(1);
}
