# Reasoning-Driven Parameter Optimization (`/optim`)

momo Code's `/optim` workflow turns parameter tuning into a **logic-reasoning-driven**
process, inspired by [optim-agent](https://optim-agent.github.io/optim-agent/).
Instead of treating your system as a blind black-box function, the agent:

1. **Reads the code first** — and infers the *physical meaning* and *business role*
   of every parameter (a semantic map), so `"lr=0.1 diverged"` is a fact it knows
   how to respond to, not just a bad data point.
2. **Reasons explicitly** — every proposal carries a `_reasoning` (why this point,
   referencing trial evidence) and a `_note` (a qualitative observation about the
   objective landscape, fed back to the agent on the next trial as a persistent
   scratchpad).
3. **Never crashes** — invalid proposals are clamped/retried once, then degrade to
   random sampling with a warning. A flaky agent can never kill a study.

## Workflow

```
read code → semantic map (human approve) → study(ask/tell)
          → reasoning proposal (_reasoning/_note) → evaluate → history feedback → iterate
```

```
┌────────────┐   draft    ┌──────────────┐  approve   ┌─────────┐
│ /optim scan│ ─────────► │ SEMANTICS.md │ ─────────► │ approved│
│ (read code)│            │ (human review)│            │   map   │
└────────────┘            └──────────────┘            └────┬────┘
                                                           ▼
┌───────────┐  feedback  ┌──────────┐  propose   ┌──────────────┐
│ trials.jsonl│ ◄──────── │ evaluate │ ◄───────── │ AgentSampler │
│ (reasoning  │  metric    │ (cmd/sim)│  {params,   │ (harness     │
│  trace)     │            │          │  _reasoning,│  prompt)     │
└───────────┘            └──────────┘  _note}     └──────────────┘
```

## Commands

```bash
# 1. Read code → draft semantic map (physical meaning / business role per param)
momo /optim scan src/train.py --param=lr:1e-5:1e-1:log --param=dropout:0:0.5

# 2. Create a study (search space is frozen at init)
momo /optim init llm-quality \
  --target=src/serve.py \
  --param=threshold:0.05:0.95 \
  --param=budget:10:200:int,log \
  --metric=score --direction=max \
  --cmd="python eval.py --threshold {threshold} --budget {budget}" \
  --context="maximize answer quality under a strict per-request cost budget"

# 3. Review the generated SEMANTICS.md, then approve (human gate)
momo /optim semantics llm-quality approve

# 4. Run the reasoning-driven loop
momo /optim run llm-quality --trials=20

# Inspect
momo /optim status llm-quality
momo /optim history llm-quality        # includes _reasoning / _note trace
momo /optim list
```

## Evaluators

| Mode | How it works |
|---|---|
| `--cmd` | Business logic: run a shell command; `{param}` placeholders are substituted and `OPTIM_<NAME>` env vars exported. Metric parsed from the last `<key>=<float>` stdout line (or a JSON line containing the key). |
| `--sim` | Physics: run experiment code in the persistent Genesis world (SimBridge), then evaluate the metric expression in the world namespace. Honors **ESTOP** — an active emergency stop fails the trial instead of executing. |

## Design principles

- **Semantics are the highest-leverage knob.** The approved semantic map
  (per-parameter context, units, interactions, evaluator constraints) is injected
  into every sampler prompt. Without approval the study still runs — as a blind
  optimizer, with the prompt explicitly marked degraded.
- **Reasoning is a first-class artifact.** `_reasoning`/`_note` are stored in
  `trials.jsonl` alongside params and values, so the full decision trace persists
  across sessions and feeds `/refine`.
- **Frozen search space.** Re-declaring a parameter with different bounds/type
  mid-study raises loudly — a changed distribution would invalidate the history
  the agent reasons over. Start a new study instead.
- **Graceful degradation.** No provider → random sampling. Garbage reply → one
  corrective retry → random point + warning. NaN/Infinity/wrong categorical →
  rejected. The study always continues.

## Storage

`~/.momo/optim/studies/<name>/`:

| File | Content |
|---|---|
| `study.json` | Frozen config (direction, space, metric, evaluator) |
| `trials.jsonl` | Append-only trial history (params, value, `_reasoning`, `_note`) |
| `semantics.json` | Semantic map + status machine `draft → approved` |
| `SEMANTICS.md` | Human-readable rendering (review/edit, then approve) |

Resuming is automatic: `run` reads the existing history, so the agent's prompt
includes pre-resume trials and numbering continues without collision.

## Environment

| Variable | Default | Description |
|---|---|---|
| `MOMO_OPTIM_HISTORY` | 5 | Recent trials shown to the agent per proposal |
| `MOMO_OPTIM_N_INIT` | 2 | Random warmup trials before the agent is consulted |
| `MOMO_OPTIM_TIMEOUT` | 300 | Seconds per sampler LLM call |

## vs `/evolve`

The two loops coexist: `/evolve` is the **experience fast loop** — statistical
(Thompson sampling over session tactics, no LLM in the loop). `/optim` is the
**reasoning loop** — an LLM reads code, understands parameter semantics, and
chooses configurations with explicit justification. Use `/evolve` for session
tactics, `/optim` for parameter spaces with physical/business meaning.
