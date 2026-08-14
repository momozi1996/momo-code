/**
 * /graph command — multi-subagent Graph Engine for long-horizon tasks.
 *
 *   momo /graph run "<task>" [--max-nodes=N] [--json]
 *                                 Plan a graph → execute subagents in
 *                                 parallel → synthesize a final report
 *   momo /graph resume <id> [--json]
 *                                 Continue a persisted run where it stopped
 *   momo /graph approve <id> [--json]
 *                                 Approve waiting approval nodes, continue
 *   momo /graph reject <id> [--json]
 *                                 Reject waiting approval nodes, continue
 *   momo /graph status <id> [--json]
 *                                 Node states + outputs of a run
 *   momo /graph list [--json]     Recent runs
 *
 * Runs persist to ~/.momo/graphs/<id>.json after every node batch, so
 * long-horizon tasks survive restarts. Results are recorded as session
 * trajectories, feeding /refine.
 */
import { recordSession } from "../../session/recorder.js"
import { currentDepth, maxDepth } from "../../subagent/spawn.js"
import { approveRun, rejectRun, resumeGraph, runGraph } from "../../graph/engine.js"
import { listRuns, loadRun } from "../../graph/store.js"

const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const RED = "\x1b[31m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const MAGENTA = "\x1b[95m"

function printUsage(): void {
  console.log(`${MAGENTA}momo /graph${RESET} — multi-subagent Graph Engine (long-horizon tasks)`)
  console.log(``)
  console.log(`  momo /graph run "<task>" [--max-nodes=N]  Plan a graph → run subagents → synthesize`)
  console.log(`  momo /graph resume <id>                   Continue a persisted run`)
  console.log(`  momo /graph approve <id>                  Approve waiting approval nodes, continue`)
  console.log(`  momo /graph reject <id>                   Reject waiting approval nodes, continue`)
  console.log(`  momo /graph status <id> [--json]          Node states + outputs`)
  console.log(`  momo /graph list                          List recent runs`)
  console.log(``)
  console.log(`Env: MOMO_GRAPH_MAX_NODES (12), MOMO_GRAPH_MAX_RETRIES (2), MOMO_GRAPH_CONCURRENCY`)
  console.log(`     MOMO_GRAPH_MAX_REWORK (2), MOMO_RLM_BUDGET (4), MOMO_RLM_TIMEOUT_MS (300000)`)
  console.log(`Storage: ~/.momo/graphs/<id>.json`)
}

interface GraphArgs {
  positional: string[]
  flags: Map<string, string>
  bools: Set<string>
}

function parseArgs(args: string[]): GraphArgs {
  const r: GraphArgs = { positional: [], flags: new Map(), bools: new Set() }
  for (const a of args) {
    if (a.startsWith("--")) {
      const eq = a.indexOf("=")
      if (eq === -1) r.bools.add(a.slice(2))
      else r.flags.set(a.slice(2, eq), a.slice(eq + 1))
    } else {
      r.positional.push(a)
    }
  }
  return r
}

function nodeMark(state: string): string {
  switch (state) {
    case "done": return `${GREEN}✓${RESET}`
    case "failed": return `${RED}✗${RESET}`
    case "skipped": return `${YELLOW}~${RESET}`
    case "running": return `${CYAN}▶${RESET}`
    case "waiting": return `${YELLOW}⏸${RESET}`
    default: return `${DIM}·${RESET}`
  }
}

function tokensLabel(tokens: { total?: number } | undefined): string {
  return tokens?.total ? ` · ${tokens.total} tok` : ""
}

async function cmdRun(args: GraphArgs): Promise<void> {
  const task = args.positional.join(" ")
  if (!task) {
    console.error(`Usage: momo /graph run "<task>" [--max-nodes=N]`)
    process.exit(1)
  }
  const json = args.bools.has("json")
  const maxNodes = args.flags.has("max-nodes") ? Number(args.flags.get("max-nodes")) || undefined : undefined
  const maxRetries = args.flags.has("max-retries") ? Number(args.flags.get("max-retries")) || undefined : undefined

  const startMs = Date.now()
  console.error(`${DIM}→ planning graph (depth ${currentDepth()}/${maxDepth()})…${RESET}`)
  const run = await runGraph(task, {
    ...(maxNodes ? { maxNodes } : {}),
    ...(maxRetries ? { maxRetries } : {}),
    onNode: (node, index, total) => {
      console.error(
        `  ${nodeMark(node.state)} ${CYAN}[${index + 1}/${total}]${RESET} ${node.id} — ${node.state} ${DIM}(${node.task.slice(0, 60)})${RESET}`,
      )
    },
  })

  await recordSession({
    provider: "graph",
    model: "graph-engine",
    prompt: `[graph] ${task}`,
    response:
      `${run.nodes.length} nodes · status=${run.status}\n` +
      run.nodes
        .map((n) => `#${n.id} ${n.state}${n.output ? ` | ${n.output.slice(0, 200)}` : ""}${n.error ? ` | ERR ${n.error.slice(0, 200)}` : ""}`)
        .join("\n") +
      (run.output ? `\n\nSYNTHESIS:\n${run.output.slice(0, 4000)}` : ""),
    exitCode: run.status === "failed" ? 1 : 0,
    durationMs: Date.now() - startMs,
    rlmDepth: currentDepth(),
  })

  if (json) {
    console.log(JSON.stringify(run, null, 2))
    return
  }

  console.error(``)
  for (const n of run.nodes) {
    console.error(`  ${nodeMark(n.state)} ${CYAN}${n.id}${RESET} ${DIM}${n.task.slice(0, 80)}${RESET}${tokensLabel(n.tokens)}`)
    if (n.error) console.error(`      ${RED}${n.error.slice(0, 160)}${RESET}`)
  }
  console.error(``)
  if (run.status === "waiting") {
    console.error(`${YELLOW}⏸  Run paused — awaiting human approval.${RESET}`)
    console.error(`  ${CYAN}momo /graph approve ${run.id}${RESET}  to approve and continue`)
    console.error(`  ${CYAN}momo /graph reject ${run.id}${RESET}  to reject`)
    return
  }
  console.log(run.output ?? "(no synthesis)")
  if (run.status === "failed") process.exit(1)
}

async function cmdResume(args: GraphArgs): Promise<void> {
  const id = args.positional[0]
  if (!id) {
    console.error(`Usage: momo /graph resume <id>`)
    process.exit(1)
  }
  const json = args.bools.has("json")
  const startMs = Date.now()
  const run = await resumeGraph(id, {
    onNode: (node, index, total) => {
      console.error(`  ${nodeMark(node.state)} ${CYAN}[${index + 1}/${total}]${RESET} ${node.id} — ${node.state}`)
    },
  })
  if (!run) {
    console.error(`${RED}Run "${id}" not found.${RESET} See: momo /graph list`)
    process.exit(1)
  }
  await recordSession({
    provider: "graph",
    model: "graph-engine",
    prompt: `[graph resume] ${id}`,
    response: `status=${run.status}\n${run.output ?? ""}`.slice(0, 4000),
    exitCode: run.status === "failed" ? 1 : 0,
    durationMs: Date.now() - startMs,
    rlmDepth: currentDepth(),
  })
  if (json) {
    console.log(JSON.stringify(run, null, 2))
    return
  }
  if (run.status === "waiting") {
    console.error(`${YELLOW}⏸  Run paused — awaiting human approval.${RESET}`)
    console.error(`  ${CYAN}momo /graph approve ${run.id}${RESET}  to approve and continue`)
    console.error(`  ${CYAN}momo /graph reject ${run.id}${RESET}  to reject`)
    return
  }
  console.log(run.output ?? "(no synthesis)")
  if (run.status === "failed") process.exit(1)
}

/** Shared approve/reject plumbing: mutate waiting nodes, resume, report. */
async function cmdDecide(action: "approve" | "reject", args: GraphArgs): Promise<void> {
  const id = args.positional[0]
  if (!id) {
    console.error(`Usage: momo /graph ${action} <id>`)
    process.exit(1)
  }
  const json = args.bools.has("json")
  const startMs = Date.now()
  const fn = action === "approve" ? approveRun : rejectRun
  const run = await fn(id, {
    onNode: (node, index, total) => {
      console.error(`  ${nodeMark(node.state)} ${CYAN}[${index + 1}/${total}]${RESET} ${node.id} — ${node.state}`)
    },
  })
  if (!run) {
    console.error(`${RED}Run "${id}" not found.${RESET} See: momo /graph list`)
    process.exit(1)
  }
  await recordSession({
    provider: "graph",
    model: "graph-engine",
    prompt: `[graph ${action}] ${id}`,
    response: `status=${run.status}\n${run.output ?? ""}`.slice(0, 4000),
    exitCode: run.status === "failed" ? 1 : 0,
    durationMs: Date.now() - startMs,
    rlmDepth: currentDepth(),
  })
  if (json) {
    console.log(JSON.stringify(run, null, 2))
    return
  }
  if (run.status === "waiting") {
    console.error(`${YELLOW}⏸  Run still waiting for approval (multiple checkpoints).${RESET}`)
    console.error(`  ${CYAN}momo /graph approve ${run.id}${RESET}  to continue`)
    return
  }
  console.log(run.output ?? "(no synthesis)")
  if (run.status === "failed") process.exit(1)
}

function cmdStatus(args: GraphArgs): void {
  const id = args.positional[0]
  if (!id) {
    console.error(`Usage: momo /graph status <id> [--json]`)
    process.exit(1)
  }
  const json = args.bools.has("json")
  const run = loadRun(id)
  if (!run) {
    console.error(`${RED}Run "${id}" not found.${RESET} See: momo /graph list`)
    process.exit(1)
  }
  if (json) {
    console.log(JSON.stringify(run, null, 2))
    return
  }
  const done = run.nodes.filter((n) => n.state === "done").length
  const waiting = run.nodes.filter((n) => n.state === "waiting").length
  console.log(`${MAGENTA}Graph "${run.id}"${RESET} — ${run.status} (${done}/${run.nodes.length} done${waiting ? `, ${waiting} waiting` : ""})`)
  console.log(`  task: ${run.task.slice(0, 100)}`)
  console.log(`  created: ${run.createdAt}${run.tokens?.total ? ` · tokens: ${run.tokens.total}` : ""}`)
  if (run.status === "waiting") {
    console.log(`  ${YELLOW}⏸  awaiting human approval — approve: momo /graph approve ${run.id}${RESET}`)
  }
  for (const n of run.nodes) {
    const deps = n.dependsOn.length > 0 ? ` ${DIM}after: ${n.dependsOn.join(", ")}${RESET}` : ""
    const kind = n.kind && n.kind !== "agent" ? ` ${DIM}(${n.kind})${RESET}` : ""
    console.log(`  ${nodeMark(n.state)} ${CYAN}${n.id}${RESET} [${n.state}]${kind}${deps}${tokensLabel(n.tokens)}`)
    if (n.output && n.output.trim()) console.log(`      ${DIM}${n.output.trim().split("\n")[0].slice(0, 120)}${RESET}`)
    if (n.error) console.log(`      ${RED}${n.error.slice(0, 160)}${RESET}`)
  }
}

function cmdList(args: GraphArgs): void {
  const json = args.bools.has("json")
  const runs = listRuns()
  if (json) {
    console.log(JSON.stringify(runs, null, 2))
    return
  }
  if (runs.length === 0) {
    console.log(`${DIM}No graph runs yet. Start one: momo /graph run "<task>"${RESET}`)
    return
  }
  for (const r of runs.slice(0, 20)) {
    const done = r.nodes.filter((n) => n.state === "done").length
    console.log(
      `${CYAN}${r.id}${RESET}  ${r.status}  ${done}/${r.nodes.length} done${tokensLabel(r.tokens)}  ${DIM}${r.createdAt}${RESET}  ${r.task.slice(0, 60)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runGraphCommand(args: string[]): Promise<void> {
  const sub = args[0]
  const parsed = parseArgs(args.slice(1))
  switch (sub) {
    case "run":
      await cmdRun(parsed)
      return
    case "resume":
      await cmdResume(parsed)
      return
    case "approve":
      await cmdDecide("approve", parsed)
      return
    case "reject":
      await cmdDecide("reject", parsed)
      return
    case "status":
      cmdStatus(parsed)
      return
    case "list":
      cmdList(parsed)
      return
    default:
      if (sub && !sub.startsWith("--")) console.error(`Unknown /graph sub-command: ${sub}\n`)
      printUsage()
      if (sub && !sub.startsWith("--")) process.exit(1)
  }
}