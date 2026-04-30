#!/usr/bin/env node
// list-alerts.mjs — print all of the user's alerts with hit-rate stats.
//
// Usage:
//   node list-alerts.mjs

import { api, log, printJson } from "./lib/api.mjs";

try {
  const res = await api("GET", "/alerts");
  printJson(res.data);
} catch (err) {
  log.err(`list-alerts failed: ${err.message}`);
  process.exit(1);
}
