// Shared HTTP client for all Fasol agent scripts. Uses Node 18+ native fetch.
// Reads FASOL_API_KEY + FASOL_API_BASE_URL from the environment.

const BASE = process.env.FASOL_API_BASE_URL || "https://api.fasol.trade/trading_bot/agent";
const KEY = process.env.FASOL_API_KEY;

if (!KEY) {
  console.error("ERROR: FASOL_API_KEY env var is not set.");
  console.error("Get a key from https://fasol.trade → AI Agents → Create agent.");
  process.exit(2);
}

// Tiny coloured logger so script output is readable in a terminal.
export const log = {
  info: (msg) => console.error(`\x1b[2m${msg}\x1b[0m`),
  ok: (msg) => console.error(`\x1b[32m${msg}\x1b[0m`),
  warn: (msg) => console.error(`\x1b[33m${msg}\x1b[0m`),
  err: (msg) => console.error(`\x1b[31m${msg}\x1b[0m`),
};

// Solana mint validation — base58, 32–44 chars. Reject EVM-style and obvious
// garbage before hitting the server.
const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const assertSolanaAddress = (addr, label = "address") => {
  if (typeof addr !== "string" || !SOLANA_RE.test(addr)) {
    throw new Error(`Invalid Solana ${label}: ${addr}`);
  }
};

// Make an HTTP call against the agent API. Returns parsed JSON on 2xx; throws
// on anything else with a structured error so the caller can decide.
export const api = async (method, path, { body, query } = {}) => {
  let url = `${BASE}${path}`;
  if (query) {
    const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined));
    if ([...qs].length) url += `?${qs}`;
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  // 429 — surface Retry-After so the caller can wait properly.
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after")) || 60;
    const text = await res.text();
    const err = new Error(`rate_limit_exceeded (retry after ${retry}s): ${text}`);
    err.status = 429;
    err.retryAfter = retry;
    throw err;
  }

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${JSON.stringify(parsed)}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }

  return parsed;
};

// Pretty-print JSON for human-readable script output. The agent runtime
// captures stdout, so we print structured JSON on stdout; logs go to stderr.
export const printJson = (obj) => {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
};

// Tiny CLI flag parser — keeps scripts dependency-free. Supports
// `--flag=value` and `--flag value`. Positional args are returned in order.
export const parseArgs = (argv) => {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          flags[arg.slice(2)] = true;
        } else {
          flags[arg.slice(2)] = next;
          i++;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
};
