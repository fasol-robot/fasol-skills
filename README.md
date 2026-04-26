# Fasol Skills

A collection of [Agent Skills](https://agentskills.io) that teach AI agents how to interact with the [Fasol](https://fasol.trade) Solana memecoin trading platform. Each skill follows the standard Markdown + YAML frontmatter format and can be loaded by Claude Code, OpenClaw, or any compatible agent runtime.

## Install

```bash
npx skills add fasol-robot/fasol-skills
```

Or, if your runtime supports direct git installs:

```bash
git clone https://github.com/fasol-robot/fasol-skills ~/.config/skills/fasol
```

## Available skills

| Skill | Description |
|-------|-------------|
| [**fasol-agent**](fasol-agent/) | Autonomous Solana memecoin trading agent. Reads coin / position / deployer data and places orders (limit, TP, SL, trailing) within scopes granted by the user. Runtime scope discovery via `GET /scope`. |

## Getting an API key

Each agent needs an API key issued from the Fasol UI:

1. Open [fasol.trade](https://fasol.trade) → **AI Trade** → **AI Agents** tab
2. **Create agent** → name it, pick scopes
3. Copy the `fsl_live_...` key shown once and store it on your side
4. Provide it to your agent via the `FASOL_API_KEY` environment variable (recommended) or as a CLI flag

See [`fasol-agent/SKILL.md`](fasol-agent/SKILL.md) for the full skill body.

## Repo structure

```
fasol-skills/
├── README.md                          ← you are here
├── LICENSE
├── fasol-agent/
│   ├── SKILL.md                       ← canonical skill (Markdown + YAML frontmatter)
│   ├── package.json
│   └── scripts/
│       ├── lib/api.mjs                ← shared fetch wrapper
│       ├── get-scope.mjs              ← print agent's current scopes + tools
│       ├── coin-stats.mjs             ← fetch CoinStat for a coin
│       ├── list-positions.mjs         ← list open positions
│       ├── place-order.mjs            ← create an order (TP / SL / trailing / limit)
│       └── cancel-order.mjs           ← cancel an existing order
└── docs/
    └── workflow-monitor-and-buy.md    ← worked example: watch coin → buy with TP/SL
```

## Versioning

Versions are tracked via git tags (`v0.1.0`, `v0.2.0`, etc.). The skill file itself carries a `metadata.version` field that's bumped per breaking change.

## Contributing

Issues and PRs welcome. Skills are platform-defining contracts — keep changes backwards-compatible where possible, document any breaking changes in the PR.

## License

[MIT](LICENSE) © Fasol
