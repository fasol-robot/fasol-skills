#!/usr/bin/env node
// get-scope.mjs — print the agent's current scopes, allowed tools, and identity.
//
// Usage:
//   node get-scope.mjs

import { api, log, printJson } from "./lib/api.mjs";

try {
  const res = await api("GET", "/scope");
  printJson(res.data);
  log.ok("✓ scope fetched");
} catch (err) {
  log.err(`get-scope failed: ${err.message}`);
  process.exit(1);
}
