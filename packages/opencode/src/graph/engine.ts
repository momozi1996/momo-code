/**
 * Graph Engine — DAG executor over process-level subagents.
 *
 * Execution model:
 *   1. Plan a graph of self-contained subagent tasks (LLM planner).
 *   2. Execute topologically: every batch of ready nodes runs as child
 *      `momo` processes in parallel (capped by concurrency), with the
 *      outputs of dependency nodes passed in as context.
 *   3. Graph Engineering primitives:
 *      - `kind: "approval"` nodes pause the run until a human approves or
 *        rejects them (`momo /graph approve|reject <id>` or the dashboard).
 *      - conditional `routes` branch on node results (deterministic
 *        field/substring predicates, or a model-decided router when a
 *        route has no predicate).
 *      - `rework` routes a failed node to a fixer agent; the fixer's route
 *        back re-runs the original node (only that path re-executes).
 *   4. Failed nodes retry (maxRetries), then nodes blocked by failed
 *      dependencies are skipped; a final LLM pass synthesizes the report.
 *   5. State (incl. structured `fields` + token usage) persists after every
 *      batch — `momo /graph resume <id>` continues where it stopped.
 *
 * @module graph/engine
 */

import { spawnSubagent } from "../subagent/spawn.js"
import { chatComplete, resolveProviderConfig, type Usage } from "../cli/chat.js"
import {
  approvalNodes,
  blockedNodes,
  computeStatus,
  isTerminal,
  pickDeterministicRoute,
  planToNodes,
  readyNodes,
  stuckDormantNodes,
} from "./parse.js"
import { planTask } from "./planner.js"
import { cleanNodeError, cleanNodeOutput } from "./clean.js"
import { extractJsonObject } from "../refine/propose.js"
import { loadRun, newRunId, saveRun } from "./store.js"
import type {
  GraphNode,
  GraphRoute,
  GraphRun,
  GraphRunOpts,
  GraphTokens,
} from "./types.js"

// ---------------------------------------------------------------------------
// Defaults & env rails
// ---------------------------------------------------------------------------

function defaultMaxNodes(): number {
  return Number(process.env.MOMO_GRAPH_MAX_NODES || 12) || 12
}

function defaultMaxRetries(): number {
  return Number(process.env.MOMO_GRAPH_MAX_RETRIES || 2) || 2
}

function defaultMaxRework(): number {
  return Number(process.env.MOMO_GRAPH_MAX_REWORK || 2) || 2
}

function defaultConcurrency(): number {
  const budget = Number(process.env.MOMO_RLM_BUDGET || 4) || 4
  const graph = Number(process.env.MOMO_GRAPH_CONCURRENCY || budget) || budget
  return Math.min(graph, 8)
}

function defaultTimeoutMs(): number {
  return Number(process.env.MOMO_RLM_TIMEOUT_MS || 300_000) || 300_000
}

// ---------------------------------------------------------------------------
// Token & field helpers
// ---------------------------------------------------------------------------

function addTokens(
  a: GraphTokens | undefined,
  b: GraphTokens | undefined,
): GraphTokens {
  if (!b) return { ...(a ?? {}) }
  return {
    prompt: (a?.prompt ?? 0) + (b.prompt ?? 0),
    completion: (a?.completion ?? 0) + (b.completion ?? 0),
    total: (a?.total ?? 0) + (b.total ?? 0),
  }
}

function toGraphTokens(u: Usage): GraphTokens {
  return {
    ...(u.promptTokens !== undefined ? { prompt: u.promptTokens } : {}),
    ...(u.completionTokens !== undefined ? { completion: u.completionTokens } : {}),
    ...(u.totalTokens !== undefined ? { total: u.totalTokens } : {}),
  }
}

/**
 * Parse structured result fields from a node's output. Only accepted when
 * the output ends with a balanced JSON object (so code snippets with braces
 * are not misread).
 */
function parseFields(output: string): Record<string, unknown> | undefined {
  const trimmed = (output ?? "").trimEnd()
  if (!trimmed.endsWith("}")) return undefined
  const obj = extractJsonObject(trimmed)
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    return obj as Record<string, unknown>
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Conditional routing
// ---------------------------------------------------------------------------

const ROUTER_SYSTEM = `You are a graph router. Given the output of a finished node and a list of
branch labels, reply with ONLY the label that best matches (one word, no
prose, no quotes).`

/** Pick the next branch: deterministic predicate first, then model-decided. */
async function decideRoute(
  routes: readonly GraphRoute[],
  node: GraphNode,
  run: GraphRun,
): Promise<GraphRoute | null> {
  const deterministic = pickDeterministicRoute(routes, node)
  if (deterministic) return deterministic

  const modelRoutes = routes.filter((r) => !r.if)
  if (modelRoutes.length === 0) return null

  const provider = await resolveProviderConfig()
  if (!provider || !provider.baseUrl) return modelRoutes[0]

  const labels = modelRoutes.map((r) => r.when).join(", ")
  try {
    const reply = await chatComplete({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      system: ROUTER_SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `Node "${node.id}" task: ${node.task}\n\nNode output:\n` +
            `${(node.output ?? "").slice(0, 2000)}\n\nPick one label: ${labels}`,
        },
      ],
      stream: false,
      temperature: 0,
      timeout: 60_000,
      onUsage: (u) => {
        run.tokens = addTokens(run.tokens, toGraphTokens(u))
      },
    })
    const pick = reply.trim().toLowerCase()
    const exact = modelRoutes.find((r) => r.when.toLowerCase() === pick)
    if (exact) return exact
    const contains = modelRoutes.find((r) => pick.includes(r.when.toLowerCase()))
    return contains ?? modelRoutes[0]
  } catch {
    return modelRoutes[0]
  }
}

/** Activate a route target; rework cycles reset the target for re-execution. */
function activateTarget(run: GraphRun, targetId: string, contextNote?: string): void {
  const target = run.nodes.find((n) => n.id === targetId)
  if (!target) return
  target.activated = true
  if (contextNote !== undefined) target.contextNote = contextNote
  if (target.state !== "pending") {
    // Rework re-run: clear the old result so the node executes again.
    target.state = "pending"
    target.output = undefined
    target.error = undefined
    target.fields = undefined
    target.finishedAt = undefined
    target.routesFired = false
    target.contextNote = undefined
  }
}

/** Evaluate a finished node's routes and activate the winning target. */
async function evaluateRoutes(run: GraphRun, node: GraphNode): Promise<void> {
  if (node.routesFired || !node.routes || node.routes.length === 0) return
  node.routesFired = true
  const route = await decideRoute(node.routes, node, run)
  if (route) activateTarget(run, route.to)
}

/** Route a failed node to its rework agent (bounded by MOMO_GRAPH_MAX_REWORK). */
function routeFailure(run: GraphRun, node: GraphNode): void {
  if (!node.rework) return
  const budget = defaultMaxRework()
  if ((node.reworkCount ?? 0) >= budget) return
  const target = run.nodes.find((n) => n.id === node.rework)
  if (!target) return
  node.reworkCount = (node.reworkCount ?? 0) + 1
  const note =
    `Fix the failure from node "${node.id}" (${node.task}):\n` +
    `${node.error ?? "unknown error"}`
  activateTarget(run, target.id, note)
}

// ---------------------------------------------------------------------------
// Single node execution
// ---------------------------------------------------------------------------

async function runNode(node: GraphNode, run: GraphRun, timeoutMs: number): Promise<void> {
  node.attempts = (node.attempts ?? 0) + 1
  const deps = run.nodes.filter((d) => node.dependsOn.includes(d.id))
  const context = deps
    .filter((d) => d.state === "done" && d.output)
    .map((d) => `--- dependency "${d.id}": ${d.task} ---\n${(d.output ?? "").slice(0, 4000)}`)
    .join("\n\n")

  const note = node.contextNote ? `\n\n${node.contextNote}` : ""
  let prompt = context
    ? `Graph task: ${run.task}\n\nDependency results:\n${context}\n\nYour node task:\n${node.task}${note}`
    : `${node.task}${note}`

  // sim nodes dispatch to the /sim world agent instead of a chat subagent
  const spawnArgs = node.kind === "sim" ? ["/sim", "run", prompt, "--json"] : undefined

  let lastError = ""
  for (let attempt = 0; attempt <= node.maxRetries; attempt++) {
    const result = await spawnSubagent(prompt, {
      timeoutMs,
      ...(spawnArgs ? { args: spawnArgs } : {}),
    })
    node.retries = attempt + 1
    node.tokens = addTokens(node.tokens, result.tokens)
    const cleaned = cleanNodeOutput(result.output)
    if (result.exitCode === 0 && cleaned.length > 0) {
      node.output = cleaned
      node.state = "done"
      node.finishedAt = new Date().toISOString()
      node.fields = parseFields(cleaned)
      return
    }
    lastError = result.timedOut
      ? `subagent timed out after ${Math.round(timeoutMs / 1000)}s`
      : cleanNodeError(result.output || result.stderrOutput).slice(0, 500) ||
        `subagent exited with code ${result.exitCode}`
    if (attempt < node.maxRetries) {
      prompt =
        `${prompt}\n\n[retry ${attempt + 1}/${node.maxRetries}] ` +
        `Previous attempt failed: ${lastError}\nFix the approach and try again.`
    }
  }

  node.state = "failed"
  node.error = lastError
  node.finishedAt = new Date().toISOString()
}

// ---------------------------------------------------------------------------
// Execution loop
// ---------------------------------------------------------------------------

/** Execute all pending nodes of a run, persisting after every batch. */
export async function executeGraph(
  run: GraphRun,
  opts: GraphRunOpts = {},
): Promise<void> {
  const concurrency = opts.concurrency ?? defaultConcurrency()
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs()
  const total = run.nodes.length
  const budget = Math.max(run.nodes.length * 8, 16) // total executions safety rail

  // A resumed run may have crashed mid-batch: reset interrupted nodes
  // so they can be re-executed (they never produced a result).
  for (const n of run.nodes) {
    if (n.state === "running") {
      n.state = "pending"
      n.startedAt = undefined
    }
  }

  if (run.status !== "waiting") run.status = "running"
  run.updatedAt = new Date().toISOString()
  saveRun(run)

  while (!isTerminal(run.nodes)) {
    // 1. Evaluate conditional edges for finished nodes, and route failures
    //    to rework agents (a rework loop re-runs only the failing path).
    for (const n of run.nodes) {
      if (n.state === "done" && !n.routesFired && n.routes?.length) {
        await evaluateRoutes(run, n)
        saveRun(run)
      }
      if (n.state === "failed" && n.rework) {
        routeFailure(run, n)
        saveRun(run)
      }
    }

    // 2. Approval checkpoints pause the run for human review.
    const approvals = approvalNodes(run.nodes)
    if (approvals.length > 0) {
      const now = new Date().toISOString()
      for (const n of approvals) {
        n.state = "waiting"
        n.startedAt = now
      }
      run.status = "waiting"
      run.updatedAt = now
      saveRun(run)
      break
    }

    // 3. Nodes blocked by failed dependencies can never run — skip them.
    for (const n of blockedNodes(run.nodes)) {
      n.state = "skipped"
      n.error = "blocked by failed dependency"
      n.finishedAt = new Date().toISOString()
    }
    saveRun(run)

    // 4. Run the next batch of ready nodes.
    const batch = readyNodes(run.nodes).slice(0, concurrency)
    if (batch.length === 0) {
      // Nothing ready: dormant targets whose sources are all terminal will
      // never activate (e.g. a condition never fired) — finalize them.
      const stuck = stuckDormantNodes(run.nodes)
      if (stuck.length > 0) {
        const now = new Date().toISOString()
        for (const n of stuck) {
          n.state = "skipped"
          n.error = "condition never fired"
          n.finishedAt = now
        }
        saveRun(run)
      }
      break
    }

    if ((run.executions ?? 0) + batch.length > budget) {
      const now = new Date().toISOString()
      for (const n of run.nodes) {
        if (n.state === "pending") {
          n.state = "skipped"
          n.error = "execution budget exceeded"
          n.finishedAt = now
        }
      }
      saveRun(run)
      break
    }

    for (const n of batch) {
      n.state = "running"
      n.startedAt = new Date().toISOString()
    }
    saveRun(run)

    await Promise.all(batch.map((n) => runNode(n, run, timeoutMs)))
    run.executions = (run.executions ?? 0) + batch.length
    run.updatedAt = new Date().toISOString()
    saveRun(run)

    for (const n of batch) {
      const idx = run.nodes.findIndex((x) => x.id === n.id)
      opts.onNode?.(n, idx === -1 ? 0 : idx, total)
    }
  }

  if (run.status !== "waiting") {
    run.status = computeStatus(run.nodes)
    run.updatedAt = new Date().toISOString()
    saveRun(run)
  }
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

const SYNTH_SYSTEM = `You are the synthesizer of a multi-agent graph run.
Merge the node results below into one coherent final answer for the
original task. Be concise and concrete (code, decisions, findings).
Explicitly note any failed, skipped or rejected nodes instead of hiding
them.`

function joinedOutput(run: GraphRun): string {
  return run.nodes
    .map((n) => {
      const head = `--- node ${n.id}: ${n.task} [${n.state}] ---`
      const body = n.output ? n.output.slice(0, 4000) : n.error ?? "(no output)"
      return `${head}\n${body}`
    })
    .join("\n\n")
}

/** Produce the final report from node outputs (LLM with fallback). */
export async function synthesizeRun(
  run: GraphRun,
  _opts: GraphRunOpts = {},
): Promise<string> {
  const done = run.nodes.filter((n) => n.state === "done" && n.output)
  if (done.length === 0) {
    const failures = run.nodes
      .filter((n) => n.error)
      .map((n) => `- ${n.id}: ${n.error}`)
      .join("\n")
    return failures ? `No nodes succeeded:\n${failures}` : "No nodes succeeded."
  }

  const provider = await resolveProviderConfig()
  if (!provider || !provider.baseUrl) return joinedOutput(run)

  const evidence = run.nodes
    .map((n) => {
      const status = n.state === "done" ? "ok" : n.error ?? n.state
      return `--- node ${n.id}: ${n.task} [${status}] ---\n${(n.output ?? "").slice(0, 3000)}`
    })
    .join("\n\n")

  try {
    return await chatComplete({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.model,
      system: SYNTH_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Original task:\n${run.task}\n\nNode results:\n${evidence}`,
        },
      ],
      stream: false,
      temperature: 0.3,
      timeout: 180_000,
      onUsage: (u) => {
        run.tokens = addTokens(run.tokens, toGraphTokens(u))
      },
    })
  } catch {
    return joinedOutput(run)
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Plan + execute + synthesize a new long-horizon graph run. */
export async function runGraph(
  task: string,
  opts: GraphRunOpts = {},
): Promise<GraphRun> {
  const maxNodes = opts.maxNodes ?? defaultMaxNodes()
  const maxRetries = opts.maxRetries ?? defaultMaxRetries()

  const planTokens: GraphTokens = {}
  const plan = await planTask(task, maxNodes, (t) => {
    Object.assign(planTokens, addTokens(planTokens, t))
  })
  const now = new Date().toISOString()
  const run: GraphRun = {
    id: opts.id ?? newRunId(),
    task,
    status: "planned",
    maxNodes,
    createdAt: now,
    updatedAt: now,
    nodes: planToNodes(plan, maxRetries),
    tokens: planTokens,
    executions: 0,
  }
  saveRun(run)

  await executeGraph(run, opts)
  run.output = await synthesizeRun(run, opts)
  run.updatedAt = new Date().toISOString()
  saveRun(run)
  return run
}

/** Resume a persisted run: execute remaining nodes + re-synthesize. */
export async function resumeGraph(
  id: string,
  opts: GraphRunOpts = {},
): Promise<GraphRun | null> {
  const run = loadRun(id)
  if (!run) return null

  await executeGraph(run, opts)
  run.output = await synthesizeRun(run, opts)
  run.updatedAt = new Date().toISOString()
  saveRun(run)
  return run
}

/** Mark waiting approval nodes approved, then continue the run. */
export async function approveRun(
  id: string,
  opts: GraphRunOpts = {},
): Promise<GraphRun | null> {
  const run = loadRun(id)
  if (!run) return null
  const now = new Date().toISOString()
  let touched = false
  for (const n of run.nodes) {
    if (n.state === "waiting") {
      n.state = "done"
      n.approved = true
      n.output = "approved by human"
      n.finishedAt = now
      touched = true
    }
  }
  if (touched) {
    // Drop the paused status so executeGraph recomputes the final one.
    run.status = "running"
    run.updatedAt = now
    saveRun(run)
  }
  return resumeGraph(id, opts)
}

/** Mark waiting approval nodes rejected (failed), then continue the run. */
export async function rejectRun(
  id: string,
  opts: GraphRunOpts = {},
): Promise<GraphRun | null> {
  const run = loadRun(id)
  if (!run) return null
  const now = new Date().toISOString()
  let touched = false
  for (const n of run.nodes) {
    if (n.state === "waiting") {
      n.state = "failed"
      n.approved = false
      n.error = "rejected by human"
      n.finishedAt = now
      touched = true
    }
  }
  if (touched) {
    // Drop the paused status so executeGraph recomputes the final one.
    run.status = "running"
    run.updatedAt = now
    saveRun(run)
  }
  return resumeGraph(id, opts)
}