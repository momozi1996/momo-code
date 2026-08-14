import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  approvalNodes,
  blockedNodes,
  computeStatus,
  evaluateCondition,
  parseGraphPlan,
  pickDeterministicRoute,
  planToNodes,
  readyNodes,
  singleNodePlan,
  stuckDormantNodes,
  topologicalLevels,
  validatePlan,
} from "../graph/parse.js"
import { listRuns, loadRun, newRunId, saveRun } from "../graph/store.js"
import type { GraphNode, GraphPlan, GraphRun } from "../graph/types.js"

// ---------------------------------------------------------------------------
// Isolation (MOMO_CONFIG_DIR → tmp)
// ---------------------------------------------------------------------------

let tmp: string
let saved: string | undefined

before(() => {
  saved = process.env.MOMO_CONFIG_DIR
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momo-graph-test-"))
  process.env.MOMO_CONFIG_DIR = tmp
})

after(() => {
  if (saved === undefined) delete process.env.MOMO_CONFIG_DIR
  else process.env.MOMO_CONFIG_DIR = saved
  fs.rmSync(tmp, { recursive: true, force: true })
})

function makeRun(overrides: Partial<GraphRun> = {}): GraphRun {
  const now = new Date().toISOString()
  return {
    id: newRunId(),
    task: "test task",
    status: "planned",
    maxNodes: 4,
    createdAt: now,
    updatedAt: now,
    nodes: planToNodes(
      {
        nodes: [
          { id: "a", task: "A" },
          { id: "b", task: "B", dependsOn: ["a"] },
        ],
      },
      1,
    ),
    executions: 0,
    ...overrides,
  }
}

function nodes(plan: GraphPlan): GraphNode[] {
  return planToNodes(plan, 1)
}

describe("graph plan parsing", () => {
  it("parses a valid DAG plan", () => {
    const plan = parseGraphPlan({
      nodes: [
        { id: "research", task: "Research APIs", dependsOn: [] },
        { id: "implement", task: "Implement feature", dependsOn: ["research"] },
      ],
    })
    assert.ok(plan)
    assert.strictEqual(plan.nodes.length, 2)
    assert.deepStrictEqual(plan.nodes[1].dependsOn, ["research"])
  })

  it("normalizes ids/tasks and drops bad entries", () => {
    const plan = parseGraphPlan({
      nodes: [
        { id: "  a  ", task: "  task a  " },
        { id: "", task: "empty id" },
        { id: "b", task: "" },
        { id: "c", task: "task c", dependsOn: ["  a  ", "", 42] },
      ],
    })
    assert.ok(plan)
    assert.strictEqual(plan.nodes.length, 2)
    assert.strictEqual(plan.nodes[0].id, "a")
    assert.strictEqual(plan.nodes[0].task, "task a")
    assert.deepStrictEqual(plan.nodes[1].dependsOn, ["a"])
  })

  it("rejects missing/empty nodes", () => {
    assert.strictEqual(parseGraphPlan(null), null)
    assert.strictEqual(parseGraphPlan({}), null)
    assert.strictEqual(parseGraphPlan({ nodes: [] }), null)
    assert.strictEqual(parseGraphPlan({ nodes: [{ id: 1, task: "x" }] }), null)
  })

  it("parses node kinds (agent default, sim explicit)", () => {
    const plan = parseGraphPlan({
      nodes: [
        { id: "code", task: "Write code" },
        { id: "sim", task: "Run physics experiment", kind: "sim" },
        { id: "other", task: "x", kind: "bogus" },
      ],
    })
    assert.ok(plan)
    assert.strictEqual(plan.nodes[0].kind, undefined)
    assert.strictEqual(plan.nodes[1].kind, "sim")
    assert.strictEqual(plan.nodes[2].kind, undefined)
    const ns = planToNodes(plan, 1)
    assert.strictEqual(ns[0].kind, "agent")
    assert.strictEqual(ns[1].kind, "sim")
  })

  it("tolerates prose around JSON via singleNodePlan fallback", () => {
    const plan = singleNodePlan("just do it")
    assert.strictEqual(plan.nodes.length, 1)
    assert.strictEqual(plan.nodes[0].task, "just do it")
  })
})

describe("graph plan validation", () => {
  it("accepts a valid DAG", () => {
    const plan: GraphPlan = {
      nodes: [
        { id: "a", task: "A" },
        { id: "b", task: "B", dependsOn: ["a"] },
        { id: "c", task: "C", dependsOn: ["a"] },
        { id: "d", task: "D", dependsOn: ["b", "c"] },
      ],
    }
    assert.deepStrictEqual(validatePlan(plan), [])
  })

  it("rejects duplicate ids", () => {
    const plan: GraphPlan = {
      nodes: [
        { id: "a", task: "A" },
        { id: "a", task: "A again" },
      ],
    }
    assert.ok(validatePlan(plan).some((e) => e.includes("duplicate")))
  })

  it("rejects unknown and self dependencies", () => {
    const plan: GraphPlan = {
      nodes: [
        { id: "a", task: "A", dependsOn: ["ghost"] },
        { id: "b", task: "B", dependsOn: ["b"] },
      ],
    }
    const errors = validatePlan(plan)
    assert.ok(errors.some((e) => e.includes("unknown node")))
    assert.ok(errors.some((e) => e.includes("depends on itself")))
  })

  it("rejects cycles", () => {
    const plan: GraphPlan = {
      nodes: [
        { id: "a", task: "A", dependsOn: ["c"] },
        { id: "b", task: "B", dependsOn: ["a"] },
        { id: "c", task: "C", dependsOn: ["b"] },
      ],
    }
    assert.ok(validatePlan(plan).some((e) => e.includes("cycle")))
  })
})

describe("topological levels", () => {
  it("orders a diamond graph into parallel levels", () => {
    const plan: GraphPlan = {
      nodes: [
        { id: "d", task: "D", dependsOn: ["b", "c"] },
        { id: "a", task: "A" },
        { id: "c", task: "C", dependsOn: ["a"] },
        { id: "b", task: "B", dependsOn: ["a"] },
      ],
    }
    const levels = topologicalLevels(plan)
    // level 0: a ; level 1: b,c ; level 2: d
    assert.deepStrictEqual(new Set(levels[0]), new Set(["a"]))
    assert.deepStrictEqual(new Set(levels[1]), new Set(["b", "c"]))
    assert.deepStrictEqual(new Set(levels[2]), new Set(["d"]))
  })

  it("handles chains", () => {
    const plan: GraphPlan = {
      nodes: [
        { id: "a", task: "A" },
        { id: "b", task: "B", dependsOn: ["a"] },
        { id: "c", task: "C", dependsOn: ["b"] },
      ],
    }
    const levels = topologicalLevels(plan)
    assert.deepStrictEqual(levels[0], ["a"])
    assert.deepStrictEqual(levels[1], ["b"])
    assert.deepStrictEqual(levels[2], ["c"])
  })
})

describe("ready / blocked nodes", () => {
  it("exposes roots as ready", () => {
    const ns = nodes({
      nodes: [
        { id: "a", task: "A" },
        { id: "b", task: "B", dependsOn: ["a"] },
      ],
    })
    const ready = readyNodes(ns).map((n) => n.id)
    assert.deepStrictEqual(ready, ["a"])
  })

  it("unlocks dependents once deps are done", () => {
    const ns = nodes({
      nodes: [
        { id: "a", task: "A" },
        { id: "b", task: "B", dependsOn: ["a"] },
      ],
    })
    ns[0].state = "done"
    ns[0].output = "result-a"
    assert.deepStrictEqual(readyNodes(ns).map((n) => n.id), ["b"])
  })

  it("blocks nodes whose deps failed", () => {
    const ns = nodes({
      nodes: [
        { id: "a", task: "A" },
        { id: "b", task: "B", dependsOn: ["a"] },
        { id: "c", task: "C", dependsOn: ["a"] },
      ],
    })
    ns[0].state = "failed"
    ns[0].error = "boom"
    assert.deepStrictEqual(blockedNodes(ns).map((n) => n.id), ["b", "c"])
    assert.deepStrictEqual(readyNodes(ns).map((n) => n.id), [])
  })
})

describe("run status", () => {
  it("reports running while work remains", () => {
    const ns = nodes({
      nodes: [
        { id: "a", task: "A" },
        { id: "b", task: "B", dependsOn: ["a"] },
      ],
    })
    ns[0].state = "done"
    assert.strictEqual(computeStatus(ns), "running")
  })

  it("reports done only when all nodes succeed", () => {
    const ns = nodes({
      nodes: [
        { id: "a", task: "A" },
        { id: "b", task: "B", dependsOn: ["a"] },
      ],
    })
    for (const n of ns) n.state = "done"
    assert.strictEqual(computeStatus(ns), "done")
  })

  it("reports partial when some failed but others succeeded", () => {
    const ns = nodes({
      nodes: [
        { id: "a", task: "A" },
        { id: "b", task: "B", dependsOn: ["a"] },
      ],
    })
    ns[0].state = "done"
    ns[1].state = "failed"
    assert.strictEqual(computeStatus(ns), "partial")
  })

  it("reports failed when nothing succeeded", () => {
    const ns = nodes({
      nodes: [
        { id: "a", task: "A" },
        { id: "b", task: "B", dependsOn: ["a"] },
      ],
    })
    ns[0].state = "failed"
    ns[1].state = "skipped"
    assert.strictEqual(computeStatus(ns), "failed")
  })
})

describe("planToNodes", () => {
  it("seeds pending state and retry budget", () => {
    const ns = planToNodes({ nodes: [{ id: "a", task: "A" }] }, 3)
    assert.strictEqual(ns.length, 1)
    assert.strictEqual(ns[0].state, "pending")
    assert.strictEqual(ns[0].retries, 0)
    assert.strictEqual(ns[0].maxRetries, 3)
  })
})

describe("conditional routes & rework", () => {
  it("parses routes, rework and approval kinds", () => {
    const plan = parseGraphPlan({
      nodes: [
        {
          id: "verify",
          task: "Run tests",
          routes: [
            { to: "approve", when: "pass", if: { outputContains: "ALL TESTS PASSED" } },
            { to: "fixer", when: "fail", if: { field: "tests.status", eq: ["fail"] } },
          ],
          rework: "fixer",
        },
        { id: "approve", task: "Review", kind: "approval" },
        { id: "fixer", task: "Fix", routes: [{ to: "verify", when: "done" }] },
      ],
    })
    assert.ok(plan)
    const verify = plan.nodes[0]
    assert.strictEqual(verify.routes?.length, 2)
    assert.strictEqual(verify.routes?.[0].to, "approve")
    assert.deepStrictEqual(verify.routes?.[0].if, { outputContains: "ALL TESTS PASSED" })
    assert.strictEqual(verify.routes?.[1].if?.field, "tests.status")
    assert.strictEqual(verify.rework, "fixer")
    assert.strictEqual(plan.nodes[1].kind, "approval")
  })

  it("drops malformed routes but keeps model-decided ones", () => {
    const plan = parseGraphPlan({
      nodes: [
        {
          id: "a",
          task: "A",
          routes: [
            { to: "", when: "pass" },
            { to: "b", when: "fail", if: { eq: [] } },
            "bogus",
          ],
        },
        { id: "b", task: "B" },
      ],
    })
    assert.ok(plan)
    // to="" dropped, "bogus" dropped, empty condition → model-decided route kept
    assert.strictEqual(plan.nodes[0].routes?.length, 1)
    assert.strictEqual(plan.nodes[0].routes?.[0].to, "b")
  })

  it("validates route and rework targets", () => {
    const plan: GraphPlan = {
      nodes: [
        { id: "a", task: "A", routes: [{ to: "ghost", when: "pass" }] },
        { id: "b", task: "B", rework: "a" },
        { id: "c", task: "C", routes: [{ to: "c", when: "x" }] },
        { id: "d", task: "D", rework: "d" },
      ],
    }
    const errors = validatePlan(plan)
    assert.ok(errors.some((e) => e.includes("unknown node")))
    assert.ok(errors.some((e) => e.includes("route to itself")))
    assert.ok(errors.some((e) => e.includes("rework to itself")))
  })

  it("evaluates deterministic conditions", () => {
    const node: GraphNode = {
      id: "verify",
      task: "T",
      kind: "agent",
      dependsOn: [],
      state: "done",
      retries: 0,
      maxRetries: 1,
      attempts: 1,
      activated: true,
      output: "ALL TESTS PASSED (42)",
      fields: { tests: { status: "pass" }, backend: { status: "done" } },
    }
    assert.ok(evaluateCondition({ outputContains: "ALL TESTS PASSED" }, node))
    assert.ok(!evaluateCondition({ outputContains: "TESTS FAILED" }, node))
    assert.ok(evaluateCondition({ field: "tests.status", eq: ["pass"] }, node))
    assert.ok(!evaluateCondition({ field: "tests.status", eq: ["fail"] }, node))
    const routes = [
      { to: "fixer", when: "fail", if: { outputContains: "TESTS FAILED" } },
      { to: "approve", when: "pass", if: { outputContains: "ALL TESTS PASSED" } },
    ]
    assert.strictEqual(pickDeterministicRoute(routes, node)?.to, "approve")
  })

  it("seeds activated=false only for route targets", () => {
    const ns = planToNodes(
      {
        nodes: [
          { id: "a", task: "A", routes: [{ to: "b", when: "ok" }] },
          { id: "b", task: "B" },
          { id: "c", task: "C", dependsOn: ["a"] },
        ],
      },
      1,
    )
    assert.strictEqual(ns.find((n) => n.id === "a")!.activated, true)
    assert.strictEqual(ns.find((n) => n.id === "b")!.activated, false)
    assert.strictEqual(ns.find((n) => n.id === "c")!.activated, true)
  })

  it("flags dormant targets whose sources are terminal as stuck", () => {
    const ns = planToNodes(
      {
        nodes: [
          {
            id: "verify",
            task: "Verify",
            routes: [{ to: "approve", when: "pass", if: { outputContains: "PASSED" } }],
          },
          { id: "approve", task: "Approve", kind: "approval" },
        ],
      },
      1,
    )
    const verify = ns.find((n) => n.id === "verify")!
    verify.state = "done"
    verify.output = "TESTS FAILED" // the pass route never fires
    assert.deepStrictEqual(stuckDormantNodes(ns).map((n) => n.id), ["approve"])
    verify.state = "running"
    assert.deepStrictEqual(stuckDormantNodes(ns).map((n) => n.id), [])
  })
})

describe("approval checkpoints", () => {
  it("exposes satisfied approval nodes and reports waiting status", () => {
    const ns = planToNodes(
      {
        nodes: [
          { id: "dev", task: "Dev" },
          { id: "review", task: "Review", kind: "approval", dependsOn: ["dev"] },
        ],
      },
      1,
    )
    ns[0].state = "done"
    ns[0].output = "done"
    assert.deepStrictEqual(approvalNodes(ns).map((n) => n.id), ["review"])
    ns[1].state = "waiting"
    assert.strictEqual(computeStatus(ns), "waiting")
  })

  it("keeps dormant approval targets out until a route fires", () => {
    const ns = planToNodes(
      {
        nodes: [
          {
            id: "verify",
            task: "Verify",
            routes: [{ to: "approve", when: "pass", if: { outputContains: "PASSED" } }],
          },
          { id: "approve", task: "Approve", kind: "approval" },
        ],
      },
      1,
    )
    const approve = ns.find((n) => n.id === "approve")!
    assert.strictEqual(approve.activated, false)
    assert.deepStrictEqual(approvalNodes(ns).map((n) => n.id), [])
    approve.activated = true
    assert.deepStrictEqual(approvalNodes(ns).map((n) => n.id), ["approve"])
  })
})

describe("graph store", () => {
  it("round-trips a run and lists it newest-first", () => {
    const first = makeRun()
    saveRun(first)
    const second = makeRun({ task: "second task" })
    saveRun(second)

    const loaded = loadRun(first.id)
    assert.ok(loaded)
    assert.strictEqual(loaded.id, first.id)
    assert.strictEqual(loaded.nodes.length, 2)
    assert.deepStrictEqual(loaded.nodes[1].dependsOn, ["a"])

    const runs = listRuns()
    assert.strictEqual(runs.length, 2)
    // newest createdAt first (identical timestamps → stable by insertion order)
    assert.ok(runs.map((r) => r.id).includes(first.id))
  })

  it("returns null for missing runs", () => {
    assert.strictEqual(loadRun("graph_missing"), null)
  })

  it("persists execution state across save/load", () => {
    const run = makeRun()
    saveRun(run)
    const loaded = loadRun(run.id)!
    loaded.nodes[0].state = "done"
    loaded.nodes[0].output = "result-a"
    loaded.status = "running"
    saveRun(loaded)

    const reloaded = loadRun(run.id)!
    assert.strictEqual(reloaded.nodes[0].state, "done")
    assert.strictEqual(reloaded.nodes[0].output, "result-a")
    assert.strictEqual(reloaded.status, "running")
  })
})
