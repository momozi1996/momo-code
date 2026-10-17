import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { executeGraph, rejectRun } from "../graph/engine.js"
import { planToNodes } from "../graph/parse.js"
import { loadRun, newRunId, saveRun } from "../graph/store.js"
import type { GraphPlan, GraphRun } from "../graph/types.js"

let tmp: string
let saved: string | undefined

before(() => {
  saved = process.env.MOMO_CONFIG_DIR
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momo-graph-execution-test-"))
  process.env.MOMO_CONFIG_DIR = tmp
})

after(() => {
  if (saved === undefined) delete process.env.MOMO_CONFIG_DIR
  else process.env.MOMO_CONFIG_DIR = saved
  fs.rmSync(tmp, { recursive: true, force: true })
})

function makeRun(plan: GraphPlan): GraphRun {
  const now = new Date().toISOString()
  return {
    id: newRunId(), task: "offline graph execution", status: "running",
    maxNodes: plan.nodes.length, createdAt: now, updatedAt: now,
    nodes: planToNodes(plan, 0), executions: 0,
  }
}

function assertPersisted(run: GraphRun): void {
  assert.deepStrictEqual(loadRun(run.id), JSON.parse(JSON.stringify(run)))
  assert.strictEqual(run.executions, 0)
  assert.ok(run.nodes.every((n) => n.attempts === 0))
}

describe("graph execution skip propagation", () => {
  it("settles every descendant of a failed node regardless of plan order", async () => {
    for (const reverse of [false, true]) {
      const plan: GraphPlan = { nodes: [
        { id: "a", task: "A" },
        { id: "b", task: "B", dependsOn: ["a"] },
        { id: "c", task: "C", dependsOn: ["b"] },
        { id: "d", task: "D", dependsOn: ["c"] },
      ] }
      if (reverse) plan.nodes.reverse()
      const run = makeRun(plan)
      run.nodes.find((n) => n.id === "a")!.state = "failed"

      await executeGraph(run)

      assert.strictEqual(run.status, "failed")
      for (const node of run.nodes.filter((n) => n.id !== "a")) {
        assert.strictEqual(node.state, "skipped", node.id)
        assert.strictEqual(node.error, "blocked by failed dependency")
        assert.ok(node.finishedAt)
      }
      assertPersisted(run)
    }
  })

  it("settles downstream work after a human rejects an approval checkpoint", async () => {
    const run = makeRun({ nodes: [
      { id: "review", task: "Review", kind: "approval" },
      { id: "deploy", task: "Deploy", dependsOn: ["review"] },
      { id: "report", task: "Report", dependsOn: ["deploy"] },
    ] })
    run.status = "waiting"
    run.nodes[0].state = "waiting"
    saveRun(run)

    const rejected = await rejectRun(run.id)

    assert.ok(rejected)
    assert.strictEqual(rejected.status, "failed")
    assert.deepStrictEqual(rejected.nodes.map((n) => n.state), ["failed", "skipped", "skipped"])
    assert.strictEqual(rejected.nodes[0].approved, false)
    assertPersisted(rejected)
  })

  it("settles unchosen branches, their joins, and nested dormant routes", async () => {
    const run = makeRun({ nodes: [
      { id: "router", task: "Route", routes: [
        { to: "branch", when: "yes", if: { outputContains: "YES" } },
      ] },
      { id: "branch", task: "Branch", routes: [
        { to: "nested", when: "yes", if: { outputContains: "YES" } },
      ] },
      { id: "nested", task: "Nested branch" },
      { id: "nested-child", task: "Nested child", dependsOn: ["nested"] },
      { id: "other", task: "Completed branch" },
      { id: "join", task: "Needs both branches", dependsOn: ["branch", "other"] },
      { id: "report", task: "Report", dependsOn: ["join"] },
    ] })
    run.nodes[0].state = "done"
    run.nodes[0].output = "NO"
    run.nodes.find((n) => n.id === "other")!.state = "done"

    await executeGraph(run)

    assert.strictEqual(run.status, "partial")
    assert.deepStrictEqual(run.nodes.map((n) => n.state),
      ["done", "skipped", "skipped", "skipped", "done", "skipped", "skipped"])
    assert.strictEqual(run.nodes[1].error, "condition never fired")
    assert.strictEqual(run.nodes[2].error, "condition never fired")
    assert.strictEqual(run.nodes[5].error, "blocked by failed dependency")
    assertPersisted(run)
  })

  it("preserves a selected approval branch and leaves its dependents pending", async () => {
    const run = makeRun({ nodes: [
      { id: "router", task: "Route", routes: [
        { to: "review", when: "yes", if: { outputContains: "YES" } },
        { to: "other", when: "no", if: { outputContains: "NO" } },
      ] },
      { id: "review", task: "Review", kind: "approval" },
      { id: "other", task: "Other branch" },
      { id: "report", task: "Report", dependsOn: ["review"] },
    ] })
    run.nodes[0].state = "done"
    run.nodes[0].output = "YES"

    await executeGraph(run)

    assert.strictEqual(run.status, "waiting")
    assert.deepStrictEqual(run.nodes.map((n) => n.state), ["done", "waiting", "pending", "pending"])
    assert.strictEqual(run.nodes[1].activated, true)
    assert.strictEqual(run.nodes[2].activated, false)
    assertPersisted(run)
  })

  it("pauses for an activated rework approval without consuming extra rework attempts", async () => {
    const run = makeRun({ nodes: [
      { id: "work", task: "Work", rework: "fixer" },
      { id: "fixer", task: "Approve rework", kind: "approval", routes: [
        { to: "work", when: "retry", if: { outputContains: "approved" } },
      ] },
      { id: "report", task: "Report", dependsOn: ["work"] },
    ] })
    run.nodes[0].state = "failed"
    run.nodes[0].error = "fixture failure"

    await executeGraph(run)

    assert.strictEqual(run.status, "waiting")
    assert.deepStrictEqual(run.nodes.map((n) => n.state), ["failed", "waiting", "pending"])
    assert.strictEqual(run.nodes[0].reworkCount, 1)
    assertPersisted(run)
  })

  it("evaluates a completed fixer's return route before settling deeper descendants", async () => {
    const fixture = path.join(tmp, "rework-child.cjs")
    const marker = path.join(tmp, "work-attempted")
    fs.writeFileSync(fixture, `
      const fs = require("node:fs")
      const marker = ${JSON.stringify(marker)}
      if (process.argv[2] === "work" && !fs.existsSync(marker)) {
        fs.writeFileSync(marker, "attempted")
        console.log("fixture failure")
        process.exit(1)
      }
      console.log("success")
    `)
    const run = makeRun({ nodes: [
      { id: "fixer", task: "fixer", routes: [
        { to: "work", when: "retry", if: { outputContains: "success" } },
      ] },
      { id: "work", task: "work", rework: "fixer" },
      { id: "child", task: "child", dependsOn: ["work"] },
      { id: "grandchild", task: "grandchild", dependsOn: ["child"] },
    ] })
    const originalEntry = process.argv[1]
    const originalDepth = process.env.MOMO_RLM_DEPTH
    const completed: string[] = []
    try {
      // Re-invoke an offline child fixture through the real subagent spawner.
      process.argv[1] = fixture
      process.env.MOMO_RLM_DEPTH = "0"
      await executeGraph(run, {
        concurrency: 1, timeoutMs: 5000,
        onNode: (node) => { completed.push(node.id) },
      })
    } finally {
      process.argv[1] = originalEntry
      if (originalDepth === undefined) delete process.env.MOMO_RLM_DEPTH
      else process.env.MOMO_RLM_DEPTH = originalDepth
    }

    assert.deepStrictEqual(completed, ["fixer", "work", "fixer", "work"])
    assert.strictEqual(run.nodes[1].state, "done")
    assert.strictEqual(run.nodes[1].attempts, 2)
    assert.strictEqual(run.nodes[1].reworkCount, 1)
    assert.strictEqual(run.nodes[0].routesFired, true)
    assert.strictEqual(run.status, "partial")
    assert.deepStrictEqual(loadRun(run.id), JSON.parse(JSON.stringify(run)))
  })
})
