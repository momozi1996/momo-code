/**
 * /optim command — reasoning-driven parameter optimization.
 *
 *   momo /optim scan <path> --param=...          Read code → semantic map (draft)
 *   momo /optim init <name> --target=<path> --param=lr:1e-5:1e-1:log
 *          --metric=score --cmd="python train.py --lr {lr}"
 *   momo /optim semantics <name> [approve]       Review/approve the semantic map
 *   momo /optim run <name> --trials=20 [--mock]  Reasoning-driven optimize loop
 *   momo /optim status <name>                    Best config + progress
 *   momo /optim history <name> [--json]          Trial table (with reasoning)
 *   momo /optim list                             List studies
 *
 * The agent reads the target code first and infers the physical/business
 * meaning of every parameter; the map must be approved by a human before
 * `run` will use it. Every proposal carries explicit reasoning and a
 * qualitative note that is fed back on the next trial. Invalid proposals
 * degrade to random sampling — a flaky agent can never crash a study.
 *
 * Runs are recorded as session trajectories, feeding /refine.
 */
import { recordSession } from "../../session/recorder.js"
import { runStudy } from "../../optim/runner.js"
import { MockSampler } from "../../optim/sampler.js"
import {
  approveSemantics,
  generateSemantics,
  loadSemantics,
  renderSemanticsMarkdown,
  saveSemantics,
} from "../../optim/semantics.js"
import {
  bestTrial,
  createStudy,
  listStudies,
  loadStudy,
  parseParamSpec,
  readTrials,
  type Direction,
  type EvaluatorSpec,
  type ParamSpec,
  type StudyConfig,
  type TrialRecord,
} from "../../optim/study.js"

const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const MAGENTA = "\x1b[95m"

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`${CYAN}momo /optim${RESET} — reasoning-driven parameter optimization`)
  console.log(``)
  console.log(`  momo /optim scan <path> --param=...        Read code → semantic map (draft)`)
  console.log(`  momo /optim init <name> [options]          Create a study (frozen space)`)
  console.log(`  momo /optim semantics <name> [approve]     Review/approve semantic map`)
  console.log(`  momo /optim run <name> --trials=N [--mock] Run the optimization loop`)
  console.log(`  momo /optim status <name>                  Best config + progress`)
  console.log(`  momo /optim history <name> [--json]        Trial table (with _reasoning)`)
  console.log(`  momo /optim list                           List studies`)
  console.log(``)
  console.log(`init options:`)
  console.log(`  --target=<path>          Code the agent reads for parameter semantics`)
  console.log(`  --param=name:low:high[:log|int|int,log]   Numeric param (repeatable)`)
  console.log(`  --param=name:a,b,c                       Categorical param`)
  console.log(`  --metric=<key|expr>      cmd: stdout key (default "metric"); sim: python expr`)
  console.log(`  --direction=min|max      Default min`)
  console.log(`  --cmd="<shell cmd>"      Business evaluator; {param} placeholders`)
  console.log(`  --sim --task="<python>"  Physics evaluator in the Genesis world`)
  console.log(`  --context="<text>"       What is being tuned (highest-leverage knob)`)
  console.log(``)
  console.log(`Env: MOMO_OPTIM_HISTORY (5)  MOMO_OPTIM_N_INIT (2)  MOMO_OPTIM_TIMEOUT (300s)`)
}

// ---------------------------------------------------------------------------
// Arg helpers
// ---------------------------------------------------------------------------

interface ParsedArgs {
  positional: string[]
  params: string[]
  flags: Map<string, string>
  bools: Set<string>
}

function parseArgs(args: string[]): ParsedArgs {
  const r: ParsedArgs = { positional: [], params: [], flags: new Map(), bools: new Set() }
  for (const a of args) {
    if (a.startsWith("--param=")) r.params.push(a.slice(8))
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      if (eq === -1) r.bools.add(a.slice(2))
      else r.flags.set(a.slice(2, eq), a.slice(eq + 1))
    } else r.positional.push(a)
  }
  return r
}

function die(msg: string): never {
  console.error(`${RED}Error:${RESET} ${msg}`)
  process.exit(1)
}

function loadStudyOrDie(name: string | undefined): StudyConfig {
  if (!name) die(`Study name required. See: momo /optim`)
  const config = loadStudy(name)
  if (!config) die(`Study "${name}" not found. Create it with: momo /optim init ${name} ...`)
  return config
}

// ---------------------------------------------------------------------------
// scan — read code, print a semantic map (no study binding)
// ---------------------------------------------------------------------------

async function optimScan(args: ParsedArgs): Promise<void> {
  const target = args.positional[0]
  if (!target) die(`Usage: momo /optim scan <path> --param=name:low:high ...`)
  const space = args.params.map(parseParamSpec)
  if (space.length === 0) die(`scan needs at least one --param to explain`)

  console.error(`${DIM}→ reading ${target} …${RESET}`)
  try {
    const { map, files } = await generateSemantics(target, space)
    console.error(`${DIM}  read ${files.length} file(s): ${files.map((f) => f.split(/[\\/]/).pop()).join(", ")}${RESET}`)
    console.log(renderSemanticsMarkdown(map))
    console.log(
      `${DIM}This is a draft. Bind it to a study with /optim init --target, ` +
        `review SEMANTICS.md, then /optim semantics <name> approve.${RESET}`,
    )
  } catch (err) {
    die(err instanceof Error ? err.message : String(err))
  }
}

// ---------------------------------------------------------------------------
// init — create study (+ optional semantic map draft)
// ---------------------------------------------------------------------------

async function optimInit(args: ParsedArgs): Promise<void> {
  const name = args.positional[0]
  if (!name) die(`Usage: momo /optim init <name> --param=... (--cmd=... | --sim --task=...)`)

  const space: ParamSpec[] = args.params.map(parseParamSpec)
  if (space.length === 0) die(`init needs at least one --param`)

  let evaluator: EvaluatorSpec
  const cmd = args.flags.get("cmd")
  const task = args.flags.get("task")
  if (args.bools.has("sim")) {
    if (!task) die(`--sim requires --task="<python code with {param} placeholders>"`)
    evaluator = { kind: "sim", task }
  } else if (cmd) {
    evaluator = { kind: "cmd", cmd }
  } else {
    die(`init requires an evaluator: --cmd="<shell cmd>" or --sim --task="<python>"`)
  }

  const direction: Direction = args.flags.get("direction") === "max" ? "maximize" : "minimize"
  const metric = args.flags.get("metric") || "metric"
  const context = args.flags.get("context")

  let config: StudyConfig
  try {
    config = createStudy({
      name,
      direction,
      space,
      metric,
      ...(context ? { context } : {}),
      evaluator,
    })
  } catch (err) {
    die(err instanceof Error ? err.message : String(err))
  }

  console.log(`${GREEN}✓${RESET} Study "${name}" created (${direction} "${metric}", ${space.length} param(s))`)

  // Code reading → draft semantic map (best-effort; study works without it)
  const target = args.flags.get("target")
  if (target) {
    console.error(`${DIM}→ reading ${target} for parameter semantics …${RESET}`)
    try {
      const { map } = await generateSemantics(target, space)
      saveSemantics(name, map)
      console.log(
        `${GREEN}✓${RESET} Semantic map drafted → ${DIM}~/.momo/optim/studies/${name}/SEMANTICS.md${RESET}`,
      )
      console.log(`  Review it, then: ${CYAN}momo /optim semantics ${name} approve${RESET}`)
    } catch (err) {
      console.warn(
        `${YELLOW}warning:${RESET} semantic scan failed (${err instanceof Error ? err.message : err}) — ` +
          `the study will run as a blind optimizer until a map is approved.`,
      )
    }
  } else {
    console.log(
      `${DIM}No --target given: run "momo /optim scan" + "semantics approve" ` +
        `to enable reasoning with parameter semantics.${RESET}`,
    )
  }
}

// ---------------------------------------------------------------------------
// semantics — show / approve
// ---------------------------------------------------------------------------

function optimSemantics(args: ParsedArgs): void {
  const name = args.positional[0]
  loadStudyOrDie(name)
  const approve = args.positional[1] === "approve"

  if (approve) {
    const map = approveSemantics(name!)
    if (!map) die(`No semantic map for study "${name}". Create one with /optim init --target.`)
    console.log(`${GREEN}✓${RESET} Semantic map approved — /optim run will reason with it.`)
    return
  }

  const map = loadSemantics(name!)
  if (!map) {
    console.log(`${DIM}No semantic map yet. Run /optim scan or init with --target.${RESET}`)
    return
  }
  console.log(renderSemanticsMarkdown(map))
  if (map.status === "draft") {
    console.log(`${YELLOW}draft${RESET} — review above, then: ${CYAN}momo /optim semantics ${name} approve${RESET}`)
  }
}

// ---------------------------------------------------------------------------
// run — the optimization loop
// ---------------------------------------------------------------------------

async function optimRun(args: ParsedArgs): Promise<void> {
  const name = args.positional[0]
  const config = loadStudyOrDie(name)
  const trials = Number(args.flags.get("trials")) || 10
  const useMock = args.bools.has("mock")
  const json = args.bools.has("json")

  const semantics = loadSemantics(name!)
  const approved = semantics?.status === "approved" ? semantics : undefined
  if (semantics && !approved) {
    console.warn(
      `${YELLOW}warning:${RESET} semantic map is still a draft — running blind. ` +
        `Approve with: momo /optim semantics ${name} approve`,
    )
  }

  console.error(
    `${DIM}→ ${trials} trial(s) · ${config.direction} "${config.metric}" · ` +
      `${approved ? "semantics-driven" : "blind"} · sampler=${useMock ? "mock" : "agent"}${RESET}`,
  )

  const startMs = Date.now()
  const result = await runStudy(config, {
    trials,
    ...(useMock ? { sampler: new MockSampler() } : {}),
    ...(approved ? { semantics: approved } : {}),
    onTrial: (r: TrialRecord) => {
      if (json) return
      const mark =
        r.state === "complete" ? `${GREEN}✓` : r.state === "failed" ? `${RED}✗` : `${YELLOW}~`
      const val = r.value !== undefined ? ` ${MAGENTA}${r.value}${RESET}` : ""
      const fb = r.fallback ? `${DIM}[rnd]${RESET} ` : ""
      console.error(`  ${mark}${RESET} #${r.number} ${fb}${val} ${DIM}${JSON.stringify(r.params)}${RESET}`)
      if (r.reasoning && !json) console.error(`    ${DIM}↳ ${r.reasoning.slice(0, 120)}${RESET}`)
      if (r.error) console.error(`    ${RED}${r.error.split("\n")[0].slice(0, 160)}${RESET}`)
    },
  })

  // Record the run as a trajectory — feeds /refine
  const best = result.best
  await recordSession({
    provider: "optim",
    model: useMock ? "mock-sampler" : "agent-sampler",
    prompt: `[optim] ${name}: ${config.direction} ${config.metric} (${trials} trials)`,
    response: best
      ? `BEST: ${best.value} at ${JSON.stringify(best.params)}\n` +
        result.trials
          .slice(-trials)
          .map((t) => `#${t.number} ${t.state} value=${t.value ?? "-"} ${t.reasoning ? `| ${t.reasoning}` : ""}`)
          .join("\n")
      : `FAILED: no completed trial`,
    exitCode: best ? 0 : 1,
    durationMs: Date.now() - startMs,
    rlmDepth: Number(process.env.MOMO_RLM_DEPTH) || 0,
  })

  if (json) {
    console.log(JSON.stringify({ study: name, ran: result.ran, best }, null, 2))
    return
  }
  console.log(``)
  if (best) {
    console.log(`${MAGENTA}Best${RESET} — trial #${best.number}: ${GREEN}${best.value}${RESET}`)
    for (const [k, v] of Object.entries(best.params)) console.log(`  ${k} = ${v}`)
  } else {
    console.log(`${RED}No completed trial.${RESET}`)
  }
  if (!best) process.exit(1)
}

// ---------------------------------------------------------------------------
// status / history / list
// ---------------------------------------------------------------------------

function optimStatus(args: ParsedArgs): void {
  const name = args.positional[0]
  const config = loadStudyOrDie(name)
  const trials = readTrials(name!)
  const completed = trials.filter((t) => t.state === "complete")
  const best = bestTrial(config.direction, trials)

  console.log(`${CYAN}Study "${config.name}"${RESET} — ${config.direction} "${config.metric}"`)
  console.log(`  trials: ${trials.length} (${completed.length} complete, ${trials.length - completed.length} failed/pruned)`)
  const sem = loadSemantics(name!)
  console.log(`  semantics: ${sem ? sem.status : `${DIM}none (blind)${RESET}`}`)
  if (best) {
    console.log(`  best: ${GREEN}${best.value}${RESET} (trial #${best.number})`)
    for (const [k, v] of Object.entries(best.params)) console.log(`    ${k} = ${v}`)
  } else {
    console.log(`  best: ${DIM}none yet${RESET}`)
  }
}

function optimHistory(args: ParsedArgs): void {
  const name = args.positional[0]
  loadStudyOrDie(name)
  const trials = readTrials(name!)
  if (args.bools.has("json")) {
    console.log(JSON.stringify(trials, null, 2))
    return
  }
  if (trials.length === 0) {
    console.log(`${DIM}No trials yet.${RESET}`)
    return
  }
  for (const t of trials) {
    const val = t.value !== undefined ? ` value=${t.value}` : ""
    const fb = t.fallback ? " [random]" : ""
    console.log(`#${t.number} ${t.state}${val}${fb}  ${JSON.stringify(t.params)}`)
    if (t.reasoning) console.log(`   ${DIM}reasoning: ${t.reasoning}${RESET}`)
    if (t.note) console.log(`   ${DIM}note: ${t.note}${RESET}`)
    if (t.error) console.log(`   ${RED}${t.error.split("\n")[0]}${RESET}`)
  }
}

function optimList(): void {
  const names = listStudies()
  if (names.length === 0) {
    console.log(`${DIM}No studies. Create one: momo /optim init <name> ...${RESET}`)
    return
  }
  for (const n of names) {
    const config = loadStudy(n)
    const trials = readTrials(n)
    const best = config ? bestTrial(config.direction, trials) : null
    console.log(
      `${CYAN}${n}${RESET}  ${config?.direction ?? "?"} "${config?.metric ?? "?"}"  ` +
        `${trials.length} trial(s)${best ? `  best=${GREEN}${best.value}${RESET}` : ""}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runOptimCommand(args: string[]): Promise<void> {
  const sub = args[0]
  const parsed = parseArgs(args.slice(1))
  switch (sub) {
    case "scan":
      await optimScan(parsed)
      return
    case "init":
      await optimInit(parsed)
      return
    case "semantics":
      optimSemantics(parsed)
      return
    case "run":
      await optimRun(parsed)
      return
    case "status":
      optimStatus(parsed)
      return
    case "history":
      optimHistory(parsed)
      return
    case "list":
      optimList()
      return
    default:
      if (sub && !sub.startsWith("--")) console.error(`Unknown /optim sub-command: ${sub}\n`)
      printUsage()
      if (sub && !sub.startsWith("--")) process.exit(1)
  }
}
