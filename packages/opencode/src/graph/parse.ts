/**
 * Graph Engine — pure graph logic (unit-tested, no I/O).
 *
 * Parses and validates LLM-produced plans, computes topological levels
 * for parallel batch execution, derives which nodes are ready / blocked /
 * complete, and evaluates conditional edges (deterministic predicates).
 *
 * @module graph/parse
 */

import type {
  GraphCondition,
  GraphNode,
  GraphNodeKind,
  GraphPlan,
  GraphPlanNode,
  GraphRoute,
  GraphStatus,
} from "./types.js"

// ---------------------------------------------------------------------------
// Plan parsing
// ---------------------------------------------------------------------------

/**
 * Parse and normalize a raw LLM plan into a GraphPlan.
 * Returns null when the payload is unusable (missing/empty nodes).
 */
export function parseGraphPlan(raw: unknown): GraphPlan | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as { nodes?: unknown }
  if (!Array.isArray(obj.nodes)) return null

  const nodes: GraphPlanNode[] = []
  for (const n of obj.nodes) {
    if (!n || typeof n !== "object") continue
    const rec = n as {
      id?: unknown
      task?: unknown
      dependsOn?: unknown
      kind?: unknown
      routes?: unknown
      rework?: unknown
    }
    if (typeof rec.id !== "string" || !rec.id.trim()) continue
    if (typeof rec.task !== "string" || !rec.task.trim()) continue
    const deps = Array.isArray(rec.dependsOn)
      ? rec.dependsOn
          .filter((d): d is unknown => typeof d === "string" && d.trim().length > 0)
          .map((d) => (d as string).trim())
      : undefined
    const kind: GraphNodeKind | undefined =
      rec.kind === "sim" ? "sim" : rec.kind === "approval" ? "approval" : undefined
    const routes = Array.isArray(rec.routes)
      ? rec.routes
          .map((r): GraphRoute | null => {
            if (!r || typeof r !== "object") return null
            const route = r as { to?: unknown; when?: unknown; if?: unknown }
            if (typeof route.to !== "string" || !route.to.trim()) return null
            if (typeof route.when !== "string" || !route.when.trim()) return null
            const ifc = parseCondition(route.if)
            return {
              to: route.to.trim(),
              when: route.when.trim(),
              ...(ifc ? { if: ifc } : {}),
            }
          })
          .filter((r): r is GraphRoute => r !== null)
      : undefined
    const rework =
      typeof rec.rework === "string" && rec.rework.trim() ? rec.rework.trim() : undefined
    nodes.push({
      id: rec.id.trim(),
      task: rec.task.trim(),
      ...(kind ? { kind } : {}),
      ...(deps && deps.length > 0 ? { dependsOn: deps } : {}),
      ...(routes && routes.length > 0 ? { routes } : {}),
      ...(rework ? { rework } : {}),
    })
  }
  return nodes.length > 0 ? { nodes } : null
}

/** Normalize a raw condition object; undefined when empty/invalid. */
export function parseCondition(raw: unknown): GraphCondition | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const c = raw as { field?: unknown; eq?: unknown; outputContains?: unknown }
  const field = typeof c.field === "string" && c.field.trim() ? c.field.trim() : undefined
  const eq = Array.isArray(c.eq)
    ? c.eq.filter((v): v is string | number | boolean =>
        typeof v === "string" || typeof v === "number" || typeof v === "boolean",
      )
    : undefined
  const outputContains =
    typeof c.outputContains === "string" && c.outputContains.trim()
      ? c.outputContains.trim()
      : undefined
  if (!field && (!eq || eq.length === 0) && !outputContains) return undefined
  return {
    ...(field ? { field } : {}),
    ...(eq && eq.length > 0 ? { eq } : {}),
    ...(outputContains ? { outputContains } : {}),
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate that a plan is a well-formed graph. Returns a list of errors
 * (empty when valid). Checks: duplicate ids, unknown deps, self-deps,
 * dependency cycles, and route/rework targets.
 */
export function validatePlan(plan: GraphPlan): string[] {
  const errors: string[] = []
  const ids = new Set<string>()

  for (const n of plan.nodes) {
    if (ids.has(n.id)) errors.push(`duplicate node id "${n.id}"`)
    ids.add(n.id)
  }

  for (const n of plan.nodes) {
    if ((n.dependsOn ?? []).includes(n.id)) {
      errors.push(`node "${n.id}" depends on itself`)
    }
    for (const d of n.dependsOn ?? []) {
      if (!ids.has(d)) errors.push(`node "${n.id}" depends on unknown node "${d}"`)
    }
    if (n.rework && n.rework === n.id) {
      errors.push(`node "${n.id}" routes rework to itself`)
    }
    if (n.rework && !ids.has(n.rework)) {
      errors.push(`node "${n.id}" rework targets unknown node "${n.rework}"`)
    }
    for (const r of n.routes ?? []) {
      if (r.to === n.id) errors.push(`node "${n.id}" has a route to itself`)
      if (!ids.has(r.to)) errors.push(`node "${n.id}" route "${r.when}" targets unknown node "${r.to}"`)
    }
  }

  // Cycle detection (DFS over the static dependency graph).
  // Note: cycles through `routes`/`rework` are allowed — that is how
  // rework loops are expressed (a failing path re-executes).
  const byId = new Map(plan.nodes.map((n) => [n.id, n]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    const node = byId.get(id)
    if (node) {
      for (const d of node.dependsOn ?? []) {
        if (hasCycle(d)) return true
      }
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }
  for (const n of plan.nodes) {
    if (hasCycle(n.id)) {
      errors.push(`cycle detected in graph (around "${n.id}")`)
      break
    }
  }

  return errors
}

// ---------------------------------------------------------------------------
// Topological levels
// ---------------------------------------------------------------------------

/**
 * Compute longest-path levels for the static DAG: every node sits one level
 * above its deepest dependency, so nodes in the same level can run in
 * parallel. Assumes the plan is already validated (no dependency cycles).
 * Route/rework edges are ignored here (they are dynamic).
 */
export function topologicalLevels(plan: GraphPlan): string[][] {
  const level = new Map<string, number>()
  for (const n of plan.nodes) level.set(n.id, 0)

  // Fixpoint relaxation — terminates because the graph is acyclic.
  for (let i = 0; i <= plan.nodes.length; i++) {
    let changed = false
    for (const n of plan.nodes) {
      for (const d of n.dependsOn ?? []) {
        const candidate = (level.get(d) ?? 0) + 1
        if ((level.get(n.id) ?? 0) < candidate) {
          level.set(n.id, candidate)
          changed = true
        }
      }
    }
    if (!changed) break
  }

  const out: string[][] = []
  for (const n of plan.nodes) {
    const l = level.get(n.id) ?? 0
    ;(out[l] ??= []).push(n.id)
  }
  return out
}

// ---------------------------------------------------------------------------
// Conditional edges
// ---------------------------------------------------------------------------

/** Ids that are activated by a conditional route (they start dormant). */
export function routeTargets(plan: GraphPlan): Set<string> {
  const out = new Set<string>()
  for (const n of plan.nodes) {
    for (const r of n.routes ?? []) out.add(r.to)
  }
  return out
}

/** Resolve a dotted path against a fields object, e.g. "tests.status". */
export function getField(
  fields: Record<string, unknown> | undefined,
  path: string,
): unknown {
  if (!fields) return undefined
  let cur: unknown = fields
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/** Evaluate a deterministic condition against a node's fields/output. */
export function evaluateCondition(cond: GraphCondition, node: GraphNode): boolean {
  if (cond.field) {
    const val = getField(node.fields, cond.field)
    if (cond.eq && cond.eq.length > 0) {
      if (!cond.eq.some((v) => Object.is(val, v))) return false
    } else if (!(val === true || val === "true" || val === "pass" || val === "passed" || val === "ok")) {
      return false
    }
  }
  if (cond.outputContains) {
    if (!String(node.output ?? "").includes(cond.outputContains)) return false
  }
  return true
}

/** First route whose deterministic predicate matches (order matters). */
export function pickDeterministicRoute(
  routes: readonly GraphRoute[],
  node: GraphNode,
): GraphRoute | null {
  for (const r of routes) {
    if (r.if && evaluateCondition(r.if, node)) return r
  }
  return null
}

// ---------------------------------------------------------------------------
// Execution state derivation
// ---------------------------------------------------------------------------

/** Nodes that can run right now: pending, activated, deps all done. */
export function readyNodes(nodes: readonly GraphNode[]): GraphNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return nodes.filter((n) => {
    if (n.state !== "pending") return false
    if (n.activated === false) return false
    return (n.dependsOn ?? []).every((d) => byId.get(d)?.state === "done")
  })
}

/** Pending nodes whose static dependencies failed/skipped — they can never run. */
export function blockedNodes(nodes: readonly GraphNode[]): GraphNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return nodes.filter((n) => {
    if (n.state !== "pending") return false
    return (n.dependsOn ?? []).some((d) => {
      const dep = byId.get(d)
      return dep?.state === "failed" || dep?.state === "skipped"
    })
  })
}

/**
 * Pending approval nodes whose dependencies are satisfied and that have been
 * activated — the engine turns them into `waiting` to pause the run.
 */
export function approvalNodes(nodes: readonly GraphNode[]): GraphNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return nodes.filter((n) => {
    if (n.state !== "pending" || n.kind !== "approval") return false
    if (n.activated === false) return false
    return (n.dependsOn ?? []).every((d) => byId.get(d)?.state === "done")
  })
}

/**
 * Pending dormant targets whose activating sources are all terminal — their
 * condition can never fire, so the engine finalizes them as skipped.
 */
export function stuckDormantNodes(nodes: readonly GraphNode[]): GraphNode[] {
  return nodes.filter((n) => {
    if (n.state !== "pending" || n.activated !== false) return false
    const sources = nodes.filter((x) => (x.routes ?? []).some((r) => r.to === n.id))
    if (sources.length === 0) return false
    return sources.every(
      (s) => s.state === "done" || s.state === "failed" || s.state === "skipped",
    )
  })
}

/** Is every node in a terminal state? (`waiting` is not terminal.) */
export function isTerminal(nodes: readonly GraphNode[]): boolean {
  if (nodes.length === 0) return true
  return nodes.every((n) =>
    n.state === "done" || n.state === "failed" || n.state === "skipped"
  )
}

/** Overall run status from node states. */
export function computeStatus(nodes: readonly GraphNode[]): GraphStatus {
  if (nodes.length === 0) return "planned"
  if (nodes.some((n) => n.state === "waiting")) return "waiting"
  if (!isTerminal(nodes)) return "running"
  if (nodes.some((n) => n.state === "failed" || n.state === "skipped")) {
    return nodes.some((n) => n.state === "done") ? "partial" : "failed"
  }
  return "done"
}

// ---------------------------------------------------------------------------
// Run construction
// ---------------------------------------------------------------------------

/** Single-node fallback plan (direct execution when planning fails). */
export function singleNodePlan(task: string): GraphPlan {
  return { nodes: [{ id: "n1", task }] }
}

/** Convert a validated plan into run nodes with initial state. */
export function planToNodes(
  plan: GraphPlan,
  maxRetries: number,
): GraphNode[] {
  const targets = routeTargets(plan)
  return plan.nodes.map((n) => ({
    id: n.id,
    task: n.task,
    kind: n.kind ?? "agent",
    dependsOn: n.dependsOn ?? [],
    ...(n.routes && n.routes.length > 0 ? { routes: n.routes } : {}),
    ...(n.rework ? { rework: n.rework } : {}),
    state: "pending",
    retries: 0,
    maxRetries,
    attempts: 0,
    activated: !targets.has(n.id),
  }))
}