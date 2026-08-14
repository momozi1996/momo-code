
# MOMO CODE 

```txt

███╗   ███╗ ██████╗ ███╗   ███╗ ██████╗    ██████╗ ██████╗ ██████╗ ███████╗
████╗ ████║██╔═══██╗████╗ ████║██╔═══██╗  ██╔════╝██╔═══██╗██╔══██╗██╔════╝
██╔████╔██║██║   ██║██╔████╔██║██║   ██║  ██║     ██║   ██║██║  ██║█████╗  
██║╚██╔╝██║██║   ██║██║╚██╔╝██║██║   ██║  ██║     ██║   ██║██║  ██║██╔══╝  
██║ ╚═╝ ██║╚██████╔╝██║ ╚═╝ ██║╚██████╔╝  ╚██████╗╚██████╔╝██████╔╝███████╗
╚═╝     ╚═╝ ╚═════╝ ╚═╝     ╚═╝ ╚═════╝    ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝
```

# MOMO CODE 🔥v1.0.0

<div align="center">

<br>

<p>
<a href="https://momozi.cc" target="_blank">
  <img src="https://img.shields.io/badge/website-momozi.cc-blue" alt="Website">
</a>
 
<a href="https://huggingface.co/momozi" target="_blank">
  <img src="https://cdn.jsdelivr.net/npm/simple-icons@v12/icons/huggingface.svg" width="24" alt="Hugging Face">
</a>
 
<a href="./README_zh.md">
  <img src="https://img.shields.io/badge/docs-%E4%B8%AD%E6%96%87-orange" alt="中文文档">
</a>
</p>
</div>

<br>
<img width="1289" height="663" alt="截屏2026-06-19 16 28 16" src="https://github.com/user-attachments/assets/58441d82-7faf-4fbe-a132-b2fcf02fb7b4" />


> **AI-powered coding agent that evolves with you.**  
> Built on [opencode](https://github.com/sst/opencode) with a unique dual-speed self-evolution system based on [Pioneer Agent](https://arxiv.org/abs/2604.09791).


## Architecture
| Two-Speed Evolution Algorithm |System Technical Architecture |
|------|----------|
|<img width="1672" height="941" alt="AG" src="https://github.com/user-attachments/assets/bb127413-b647-4c7e-bd5d-696f348f8f31" />|<img width="1672" height="941" alt="SS" src="https://github.com/user-attachments/assets/176ccbff-1a24-4a81-9b77-c6e22e757760" />|

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [CLI Commands](#cli-commands)
- [Configuration](#configuration)
- [Experience Fast Loop (`/evolve`)](#experience-fast-loop-evolve)
- [Self-Evolution Training (`/fine-tune`)](#self-evolution-training-fine-tune)
- [Migrating from Claude Code](#migrating-from-claude-code)
- [Environment Variables](#environment-variables)
- [Architecture](#architecture)
- [Changelog](#changelog)
- [License](#license)

## Features

- **25+ LLM Providers** — Deepseek, Zhipu (GLM), Moonshot (Kimi), Claude, GPT-4, Gemini, Doubao, OpenRouter, Groq, Mistral, and more. The \chat` command uses OpenAI-compatible protocol only`
- **Custom Provider** — Plug in any OpenAI-compatible API with `MOMO_CUSTOM_*` env vars
- **Model Tiers** — Zero-config selection: `ultra` / `standard` / `lite`
- **Experience Fast Loop (`/evolve`)** — Second-level prompt injection via KEP protocol. Tactics distilled from success are auto-selected via Thompson sampling
- **Self-Evolution Training (`/fine-tune`)** — Hour-level weight improvement via Monte Carlo Graph Search (MCGS) + LoRA
- **Self-Refinement (`/refine`)** — Reviews session trajectories and proposes small, evidence-based improvements (tactics/prompt patches) that only take effect after human approval
- **Recursive Subagents (`/agent`)** — RLM-style task decomposition: plan → parallel child processes → synthesis, with depth/budget rails
- **Graph Engine (`/graph`)** — Long-horizon tasks as a resumable DAG of subagents: LLM-planned dependency graph, parallel execution, retries, and `/sim` world-agent nodes
- **Long-Running Work (`/goal` + `/heartbeat` + `/daemon`)** — Persistent goals injected into every session, timed tasks, and a daemon loop for multi-hour autonomy
- **Simulation Agent (`/sim`)** — LLM-driven control of a persistent Genesis physics world: the agent writes Python into a long-lived namespace (RLM-style), with skills-as-code loaded from `~/.momo/sim/skills/`
- **Voice Input (`/voice`)** — Speak your prompt: mic recording (sounddevice) → OpenAI-compatible STT (Whisper/Groq) → coding session
- **Claude Code Interop** — Seamless migration, inherits `.claude/` config, MCP servers, prompts
- **Local-first** — Your code never leaves your machine. Open source, auditable
- **Effect-powered** — Built with Effect for composable, type-safe code


## Installation

### Prerequisites

- **macOS** or **Linux** (Windows via WSL)
- **Node.js** ≥ 20.0.0 — install from https://nodejs.org if you don't have it
- **git** and **curl**

Check with:

```bash
node -v   # should print v20.x or later
npm -v
git --version
curl --version
```

### Quick install (recommended)

```bash
curl -fsSL https://momozi.cc/install | bash
```

The installer:
1. Clones the repo into \`~/.momo/lib/momo-code\`
2. Runs \`npm install\` + \`npm run build\` (about 30-60 s)
3. Drops a wrapper at \`~/.momo/bin/momo\`
4. Appends \`~/.momo/bin\` to your PATH in \`~/.zshrc\` or \`~/.bashrc\`

**Open a new terminal** (or run \`source ~/.zshrc\`) and then:

```bash
momo --version    # 1.0.0
momo --help
```

If you see \`command not found: momo\`, your PATH didn't pick up the change — see [INSTALL.md](./INSTALL.md#troubleshooting).

### From source (manual)

```bash
git clone https://github.com/momozi1996/momo-code.git
cd momo-code/packages/opencode
npm install                # installs all deps including TypeScript
npm run build              # compiles TS + fixes ESM imports
node bin/momo --version
```

### From npm

> npm package coming in v1.1. Use the **Quick install** above for v1.0.

### Uninstall

```bash
# Remove install artifacts
rm -rf ~/.momo

# Remove the PATH line from your shell rc
sed -i.bak '/# momo Code CLI/,+1d' ~/.zshrc    # zsh
sed -i.bak '/# momo Code CLI/,+1d' ~/.bashrc   # bash
```



### 1. Set up API key

```bash
# Generic key (works with any provider)
export MOMO_API_KEY=your-api-key

# Or provider-specific
export MOMO_ANTHROPIC_API_KEY=sk-ant-...
export MOMO_OPENAI_API_KEY=sk-...
```

### 2. Start coding

```bash
# Interactive mode
momo

# One-shot task
momo "Refactor auth to use Effect"

# Use a model tier
momo --model ultra "Complex architecture review"
momo --model standard "Fix the login bug"
momo --model lite "Quick code review"
```

### 3. First run

On first run, momo creates `~/.momo/`:

```
~/.momo/
├── momo.jsonc          # Config
├── sessions/           # History
├── experience/         # Learned tactics (auto-created)
│   ├── tactics.json
│   └── ledger.jsonl
└── ...
```

## Usage

### Model Tiers

| Tier | Use Case |
|------|----------|
| `ultra` | Complex tasks, large context |
| `standard` | Daily coding work |
| `lite` | Quick tasks, low latency |

### CLI Options

```bash
momo [options] [prompt]

Options:
  --model, -m <id>       Model ID or tier
  --provider, -p <name>  Provider
  --help                 Show help
  --version              Show version
```

## CLI Commands

### Coding Session

```bash
momo                     # Show help and banner
momo "prompt"            # One-shot task
momo --model claude-sonnet-4 "task"
```

### Experience Fast Loop (`/evolve`)

```bash
momo /evolve                       # Run evolution with default settings
momo /evolve --mode=explore        # Favor exploration of new tactics
momo /evolve --mode=harden         # Favor proven high-win-rate tactics
momo /evolve --mode=convention-only # Only convention-type tactics
momo /evolve --list                # Show all learned tactics
momo /evolve --inject              # Inject tactics for current task
momo /evolve --solidify            # Apply verdict, update stats
```

### Self-Evolution Training (`/fine-tune`)

```bash
momo /fine-tune              # Diagnose, show training proposal
momo /fine-tune run          # Execute training pipeline
momo /fine-tune run --dry-run # Preview without executing
momo /fine-tune status       # Check training status
momo /fine-tune promote      # Promote candidate to production
```

### Self-Refinement (`/refine`)

Reviews recent session trajectories and proposes small, reviewable
improvements. Nothing is applied without human approval.

```bash
momo /refine                 # Generate proposals from recent sessions
momo /refine list            # List proposals
momo /refine show <id>       # Inspect evidence + content
momo /refine approve <id>    # Approve (review gate)
momo /refine apply <id>      # Apply: tactic → draft, patch → prompt file
momo /refine reject <id>     # Reject
```

### Recursive Subagents (`/agent`)

RLM-style recursion: the model decomposes a complex task, subagents run
as child `momo` processes (parallel where possible), and a synthesizer
merges results.

```bash
momo /agent "Refactor the provider layer and update all callers and tests"
```

Rails: `MOMO_RLM_MAX_DEPTH` (3), `MOMO_RLM_BUDGET` (8), `MOMO_RLM_TIMEOUT_MS` (300000).

### Graph Engine (`/graph`)

Turns a long-horizon task into a **directed acyclic graph** of self-contained
subagent tasks. The model plans the DAG (with real dependencies), nodes run as
child `momo` processes — in parallel per topological level, with dependency
outputs passed downstream — failed nodes retry, and a final LLM pass
synthesizes the report. State persists to `~/.momo/graphs/<id>.json` after
every batch, so runs survive restarts.

```bash
momo /graph run "Design + implement + test a persistence layer"   # plan → execute → synthesize
momo /graph resume <id>        # Continue a long-horizon run where it stopped
momo /graph status <id>        # Node states + outputs
momo /graph list               # Recent runs
```

Nodes can be marked `"kind": "sim"` by the planner — those become simulation
agents driving the Genesis world via `/sim run`, so a graph can mix coding
subagents with physics experiments.

Rails: `MOMO_GRAPH_MAX_NODES` (12), `MOMO_GRAPH_MAX_RETRIES` (2),
`MOMO_GRAPH_CONCURRENCY` (defaults to `MOMO_RLM_BUDGET`).

### Long-Running Work (`/goal`, `/schedule`, `/heartbeat`, `/daemon`)

```bash
momo /goal add "Ship v2.0" "with full test coverage"   # Persistent goal
momo /goal list | log <id> "progress" | done <id>      # Manage goals
momo /schedule add --every=60m "run tests and report"  # Timed task
momo /schedule add --at=07:30 "daily standup summary"  # Daily task
momo /heartbeat            # Run due tasks once
momo /daemon               # Foreground loop (Ctrl+C to stop)
```

Active goals are injected into every chat session. The daemon is a
foreground process by design — background it with nohup/systemd/Task
Scheduler. Budget rails: `MOMO_DAEMON_MAX_RUNS`, `MOMO_DAEMON_MAX_HOURS` (24).

### Simulation Agent (`/sim`)

An LLM-driven agent that controls a persistent [Genesis](https://genesis-embodied-ai.github.io/)
physics world. Requires Python with `genesis-world` installed
(`pip install genesis-world`).

```bash
momo /sim doctor                      # Check python/genesis/provider setup
momo /sim run "Stack the red cube on the blue cube"   # LLM control loop
momo /sim run "<task>" --steps=40 --viewer            # Budget + live viewer
momo /sim exec "print(42)"            # One-shot world REPL
momo /sim exec --file=scene.py        # Run a script in a fresh world
momo /sim skills                      # List installed world skills
momo /sim eval --tasks=tasks.json     # Batch evaluation (fresh world per episode)
```

How it works: the CLI spawns a persistent Python process
(`python/genesis_world/server.py`) holding a Genesis scene. Each loop
step, the model replies with `{"thought": ..., "code": ...}`; the code
runs in the persistent world namespace (`gs`, `scene`, `step(n)`, your
variables survive across steps). Skills are plain `.py` files dropped
into `~/.momo/sim/skills/` — auto-loaded into every world. Sim runs are
recorded as trajectories, feeding the `/refine` self-improvement loop.

Env: `MOMO_SIM_PYTHON`, `MOMO_SIM_BACKEND` (cpu/gpu),
`MOMO_SIM_MAX_STEPS` (20), `MOMO_SIM_SERVER`.

### Reasoning-Driven Optimization (`/optim`)

Parameter tuning driven by **code understanding + explicit reasoning**
(inspired by [optim-agent](https://optim-agent.github.io/optim-agent/)).
The agent reads your code first and infers the physical/business meaning of
every parameter, then proposes configurations with explicit `_reasoning` and
a `_note` scratchpad fed forward across trials. Invalid proposals degrade to
random sampling — a flaky agent can never crash a study.

```bash
momo /optim scan src/serve.py --param=threshold:0.05:0.95   # read code → semantic map
momo /optim init quality --target=src/serve.py \
  --param=threshold:0.05:0.95 --param=budget:10:200:int,log \
  --metric=score --direction=max --cmd="python eval.py --threshold {threshold}"
momo /optim semantics quality approve     # human review gate
momo /optim run quality --trials=20       # reasoning-driven loop
momo /optim history quality               # full reasoning trace
```

Evaluators: `--cmd` (business command, metric from stdout) or `--sim`
(experiment in the Genesis world, ESTOP-honored). Studies persist under
`~/.momo/optim/studies/<name>/` and resume automatically. See
[docs/optim.md](docs/optim.md).

Env: `MOMO_OPTIM_HISTORY` (5), `MOMO_OPTIM_N_INIT` (2), `MOMO_OPTIM_TIMEOUT` (300).

### Local Server & Dashboard (`serve`)

A zero-dependency local HTTP server that exposes momo's state as a JSON
API + SSE live feed, with a single-file dashboard (no build step).

```bash
momo serve                      # http://127.0.0.1:4097 (dashboard at /)
momo serve --port=8080 --token=s3cret
```

- API: `GET /api/sessions|goals|schedule`, `GET /api/optim/studies[/:name[/trials]]`,
  `GET /api/sim/observe`, SSE `GET /api/optim/studies/:name/stream`
- Actions: `POST /api/optim/studies/:name/run`, `POST /api/sim/estop|resume`, `POST /api/chat`
- Dashboard tabs: Overview / Sessions / **Optim (live reasoning trace + best-so-far chart)** /
  Sim (ESTOP control) / Schedule & Goals / Chat
- Binds loopback by default; non-loopback requires `--token` (Bearer auth,
  `?token=` fallback for browser EventSource)

Env: `MOMO_SERVE_PORT` (4097), `MOMO_SERVE_HOST` (127.0.0.1), `MOMO_SERVE_TOKEN`.

### Voice Input (`/voice`)

Speak your prompt instead of typing. Requires `pip install sounddevice scipy`
for recording, and an OpenAI-compatible speech-to-text endpoint.

```bash
momo /voice                       # Record 5s → transcribe → run as prompt
momo /voice --seconds=10 --lang=zh
momo /voice --file=meeting.mp3    # Transcribe an audio file → run
momo /voice transcribe --file=x.wav  # Print transcription only
```

```bash
export MOMO_STT_API_KEY=sk-...       # falls back to MOMO_OPENAI_API_KEY / MOMO_API_KEY
export MOMO_STT_MODEL=whisper-1      # default
# Groq (fast, generous free tier):
export MOMO_STT_BASE_URL=https://api.groq.com/openai/v1
export MOMO_STT_MODEL=whisper-large-v3
```

### Models

```bash
momo models list         # List all models
momo models info <id>    # Show model details
momo models providers    # Show available providers
```

## Configuration

### Config File (`~/.momo/momo.jsonc`)

```jsonc
{
  "$schema": "https://momozi.cc/config.json",
  "model": "standard",
  "provider": "anthropic",
  "inheritClaudeCode": true,
  "evolve": {
    "enabled": true,
    "auto": false,
    "clusterThreshold": 10,
    "budgetUSD": 50
  }
}
```

## Experience Fast Loop (`/evolve`)

The experience fast loop (KEP — Knowledge Embedding Protocol) is momo's unique **second-level** learning system. Unlike `/fine-tune` which updates model weights over hours, `/evolve` learns and applies knowledge in **seconds** via prompt injection.

### How it works

1. **Observe** — Extract signals from sessions (test pass/fail, edit accepted/rejected, user corrections)
2. **Distill** — Convert successful patterns into compact Tactic cards
3. **Select** — Rank tactics via **Thompson sampling** (Bayesian explore/exploit)
4. **Inject** — Insert top-k tactics into the system prompt for the current task
5. **Solidify** — Apply verdict, update Beta distribution statistics
6. **Promote** — High-confidence tactics graduate to `/fine-tune` curriculum

### Three KEP Assets

| Asset | Description |
|-------|-------------|
| **Tactic** | Compact strategy card with triggers, steps, checks, guardrails |
| **Case** | Successful task record with injected tactics |
| **Ledger** | Append-only audit log (JSONL) |

### Tactic Statistics (Beta Distribution)

Each tactic tracks a Beta(α, β) distribution:
- α = 1 + wins, β = 1 + losses
- **Thompson sampling** for exploration/exploitation balance
- **UCB1** as alternative selection strategy

### Evolution Modes

| Mode | Behavior |
|------|----------|
| `balanced` (default) | Normal explore/exploit trade-off |
| `explore` | Favor new tactics, wider sampling |
| `harden` | Favor proven tactics, tighter selection |
| `convention-only` | Only convention-type tactics |

### Storage

Learned tactics are stored in `~/.momo/experience/`:
- `tactics.jsonl` — All tactic records
- `ledger.jsonl` — Audit log of all operations

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MOMO_XP_MODE` | Evolution mode | `balanced` |
| `MOMO_XP_DIR` | Storage directory | `~/.momo/experience` |

## Self-Evolution Training (`/fine-tune`)

The weight slow loop improves momo's **model weights** via fine-tuning. This runs at hour-level timescales.

### How it works

1. **Signal Mining** — Extract learning signals from sessions
2. **Curriculum Synthesis** — Build training data (Gold/Hard-neg/Replay slices)
3. **Monte Carlo Graph Search (MCGS)** — Explore training pipeline space
4. **LoRA Fine-tuning** — Train candidate model
5. **Ratchet Gate** — Ensure monotonic improvement

### Commands

```bash
momo /fine-tune              # Diagnose, show proposal
momo /fine-tune run          # Execute training
momo /fine-tune run --dry-run # Preview
momo /fine-tune status       # Check status
momo /fine-tune promote      # Promote candidate
```

### Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `MOMO_EVOLVE_ENABLED` | Enable self-evolution | `true` |
| `MOMO_EVOLVE_AUTO` | Auto-trigger training | `false` |
| `MOMO_EVOLVE_BUDGET_USD` | Max training budget | `50` |

## Migrating from Claude Code

Zero-friction migration:

1. **Config inheritance** (default ON) — `~/.claude/settings.json` auto-merged
2. **MCP servers** (default ON) — `.claude/mcp/` work out of the box
3. **Prompts** (default ON) — `.claude/prompts/` available

```bash
# Disable inheritance
export MOMO_CLAUDE_CODE_INHERIT=false
export MOMO_ONLY=1
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `MOMO_API_KEY` | Generic API key |
| `MOMO_HOME` | Home directory (default: `~/.momo`) |
| `MOMO_MODEL` | Default model/tier |
| `MOMO_PROVIDER` | Default provider |
| `MOMO_XP_MODE` | Evolution mode (balanced/explore/harden/convention-only) |
| `MOMO_XP_DIR` | Experience storage dir |
| `MOMO_SESSION_RECORD` | Set `false` to disable session trajectory recording |
| `MOMO_RLM_MAX_DEPTH` | Subagent recursion limit (default: 3) |
| `MOMO_RLM_BUDGET` | Max subagents per orchestration (default: 8) |
| `MOMO_DAEMON_INTERVAL` | Daemon poll seconds (default: 60) |
| `MOMO_DAEMON_MAX_RUNS` / `MOMO_DAEMON_MAX_HOURS` | Daemon budget rails |
| `MOMO_SIM_PYTHON` | Python executable for the sim world server |
| `MOMO_SIM_BACKEND` | Genesis backend: cpu or gpu (default: cpu) |
| `MOMO_SIM_MAX_STEPS` | Max LLM control-loop steps (default: 20) |
| `MOMO_STT_API_KEY` | STT key for /voice (OpenAI-compatible) |
| `MOMO_STT_BASE_URL` / `MOMO_STT_MODEL` | STT endpoint/model (default: OpenAI whisper-1) |
| `MOMO_VOICE_SECONDS` | Default voice recording length (default: 5) |
| `MOMO_EVOLVE_ENABLED` | Enable self-evolution |
| `MOMO_EVOLVE_BUDGET_USD` | Training budget |
| `MOMO_ANTHROPIC_API_KEY` | Anthropic key |
| `MOMO_OPENAI_API_KEY` | OpenAI key |
| `MOMO_OPENROUTER_API_KEY` | OpenRouter key |

Full list: `src/env.ts`

## Architecture

### Dual-Speed Evolution

```
┌─────────────────────────────────────────────────────────┐
│                    momo Code                             │
├─────────────────────┬───────────────────────────────────┤
│  Experience Fast    │  Weight Slow Loop                 │
│  Loop (/evolve)     │  (/fine-tune)                     │
├─────────────────────┼───────────────────────────────────┤
│  Timescale: seconds │  Timescale: hours                 │
│  Mechanism: prompt  │  Mechanism: LoRA fine-tuning      │
│   injection         │                                   │
│  Selection:         │  Search: Monte Carlo Graph        │
│   Thompson/UCB      │   Search (MCGS)                   │
│  Storage: JSONL     │  Training: LoRA                   │
│   (~/.momo/xp/)     │  Gate: Ratchet check              │
│  Bridge: promoted   │  Storage: model registry          │
│   → curriculum      │                                   │
└─────────────────────┴───────────────────────────────────┘
```

### Provider Layer

```
User Request
    |
    v
resolveModel("standard") → BUILTIN_TIERS.standard
    |                           [claude-sonnet, gpt-4.1, ...]
    v
getCredentials() → MOMO_*_API_KEY env
    |
    v
Provider Factory → baseUrl, headers, timeout
    |
    v
createModel() → LanguageModel adapter
    |
    v
wrapSSE() → Streaming with 8min timeout
```

### Project Structure

```
packages/opencode/src/
├── provider/       # 19 LLM provider integrations
├── evolve/         # Weight slow loop (/fine-tune) — MCGS
├── experience/     # Fast loop (/evolve) — KEP protocol
│   ├── tactic.ts       # Tactic model + Beta stats
│   ├── selector.ts     # Thompson/UCB selection
│   ├── injector.ts     # Prompt injection
│   ├── gate.ts         # Promotion ratchet
│   ├── bridge.ts       # Two-speed bridge
│   └── ...
├── cli/cmd/        # CLI commands
├── session/        # Prompt routing
├── config/         # Configuration
└── effect/         # Effect utilities
```

## Test Results

- **TypeScript**: `tsc --noEmit` — **0 errors**
- **Runtime**: 17/17 tests passed
- **CLI verified**: `/evolve`, `/fine-tune`, `models`, `help`

## Changelog

### v1.0.0 (2026-06-16)

**Added:**
- Experience fast loop (`/evolve`) — KEP protocol with Thompson sampling
- Weight slow loop (`/fine-tune`) — MCGS training pipeline
- CLI command system — `/evolve`, `/fine-tune`, `models`, `help`
- 53 TypeScript modules across provider/evolve/experience/cli layers
- Dual-speed evolution architecture
- Beta distribution tracking for tactic selection
- Two-speed bridge (promoted tactics → fine-tune curriculum)

**Changed:**
- Product name: kqq Code → momo Code
- bin/momo: CJS → ESM command router
- package.json: Production-ready exports, files whitelist

## License

[MIT](LICENSE) — see [NOTICE](NOTICE) for third-party attributions.
See [USE_RESTRICTIONS.md](USE_RESTRICTIONS.md) and [SECURITY.md](SECURITY.md).
