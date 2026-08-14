/**
 * Graph Engine domain types.
 *
 * A graph run is a persisted DAG of subagent tasks:
 *   - nodes carry a self-contained task plus explicit dependencies
 *   - every node executes as an independent subagent (process-level RLM)
 *   - outputs flow downstream through `dependsOn`
 *   - state persists to disk, so long-horizon runs survive restarts
 *
 * Beyond plain DAG execution the engine implements the three pillars of
 * Graph Engineering:
 *   - Node: agent / sim / approval (human checkpoint that pauses the run)
 *   - Edge: conditional routes (deterministic or model-decided) plus
 *     rework loops (a failing node routes to a fixer agent that re-triggers it)
 *   - State: structured per-node `fields` and token usage, persisted after
 *     every batch so progress, artifacts and spend are always inspectable
 *
 * @module graph/types
 */

export type GraphNodeState =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "waiting"

export type GraphStatus =
  | "planned"
  | "running"
  | "done"
  | "partial"
  | "failed"
  | "waiting"

/** How a node executes. "agent" = chat subagent, "sim" = /sim world agent,
 * "approval" = human checkpoint (the run pauses until approved/rejected). */
export type GraphNodeKind = "agent" | "sim" | "approval"

/** Token usage counters (OpenAI-compatible `usage` object). */
export interface GraphTokens {
  readonly prompt?: number
  readonly completion?: number
  readonly total?: number
}

/** Deterministic predicate for a conditional edge. */
export interface GraphCondition {
  /** Dotted path into the node's structured `fields`, e.g. "tests.status". */
  readonly field?: string
  /** The field must equal one of these values. */
  readonly eq?: Array<string | number | boolean>
  /** Fallback substring check against the node's cleaned output. */
  readonly outputContains?: string
}

/** A conditional edge: after the source node succeeds, maybe activate `to`. */
export interface GraphRoute {
  readonly to: string
  /** Branch label ("pass" | "fail" | ...). Used by model-decided routing. */
  readonly when: string
  /** Deterministic predicate. Absent → the branch is decided by the model. */
  readonly if?: GraphCondition
}

/** A node as produced by the LLM planner (before execution state). */
export interface GraphPlanNode {
  readonly id: string
  readonly task: string
  readonly dependsOn?: string[]
  readonly kind?: GraphNodeKind
  /** Conditional edges evaluated after this node succeeds. */
  readonly routes?: GraphRoute[]
  /** Node id to route failures to (rework agent). The rework agent should
   *  declare a route back to this node so the failing path re-executes. */
  readonly rework?: string
}

/** The LLM-produced plan: a DAG of nodes. */
export interface GraphPlan {
  readonly nodes: GraphPlanNode[]
}

/** A node with execution state. */
export interface GraphNode {
  readonly id: string
  readonly task: string
  readonly kind: GraphNodeKind
  readonly dependsOn: readonly string[]
  /** Conditional edges (copied from the plan, kept for runtime evaluation). */
  readonly routes?: readonly GraphRoute[]
  /** Failure routing target (copied from the plan). */
  readonly rework?: string
  state: GraphNodeState
  output?: string
  error?: string
  retries: number
  readonly maxRetries: number
  startedAt?: string
  finishedAt?: string
  /** Structured result fields (parsed from a JSON object in the output). */
  fields?: Record<string, unknown>
  /** Cumulative token usage across all attempts of this node. */
  tokens?: GraphTokens
  /** Total executions (initial run + retries + rework re-runs). */
  attempts: number
  /** True once a conditional route has activated this node. Route targets
   *  start dormant (activated = false) until their edge fires. */
  activated: boolean
  /** True when routes have been evaluated for the current output. */
  routesFired?: boolean
  /** Extra context injected by the engine (e.g. rework failure details). */
  contextNote?: string
  /** Approval outcome for `kind: "approval"` nodes. */
  approved?: boolean
  /** How many times this node has been sent to its rework agent. */
  reworkCount?: number
}

/** A full persisted graph run. */
export interface GraphRun {
  readonly id: string
  readonly task: string
  status: GraphStatus
  readonly maxNodes: number
  readonly createdAt: string
  updatedAt: string
  readonly nodes: GraphNode[]
  /** Final synthesis produced after execution. */
  output?: string
  /** Total token usage across planner, nodes, router and synthesis. */
  tokens?: GraphTokens
  /** Total node executions so far (loop safety rail). */
  executions: number
}

export interface GraphRunOpts {
  readonly maxNodes?: number
  readonly maxRetries?: number
  /** Pre-generated run id (serve returns it immediately; planner saves under this id). */
  readonly id?: string
  readonly concurrency?: number
  readonly timeoutMs?: number
  /** Progress callback after each node finishes. */
  readonly onNode?: (node: GraphNode, index: number, total: number) => void
}