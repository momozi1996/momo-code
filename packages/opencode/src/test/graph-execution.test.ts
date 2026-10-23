import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { approveRun, executeGraph, rejectRun, resumeGraph } from "../graph/engine.js"
import { getGraphOutputDir } from "../graph/extract.js"
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

  it("preserves unrelated failures when continuing after approval", async (t) => {
    // Synthesis must stay offline even when a developer has a provider configured.
    t.mock.method(globalThis, "fetch", async () => { throw new Error("offline fixture") })
    const run = makeRun({ nodes: [
      { id: "review", task: "Review", kind: "approval" },
      { id: "work", task: "Work" },
      { id: "child", task: "Child", dependsOn: ["work"] },
      { id: "report", task: "Report", dependsOn: ["child"] },
    ] })
    run.status = "waiting"
    run.nodes[0].state = "waiting"
    run.nodes[1].state = "failed"
    run.nodes[1].error = "original failure"
    saveRun(run)

    const approved = await approveRun(run.id)

    assert.ok(approved)
    assert.strictEqual(approved.status, "partial")
    assert.deepStrictEqual(approved.nodes.map((n) => n.state), ["done", "failed", "skipped", "skipped"])
    assert.strictEqual(approved.nodes[0].approved, true)
    assert.strictEqual(approved.nodes[1].error, "original failure")
    assertPersisted(approved)
  })

  it("retries failed and skipped nodes on explicit resume and persists their artifacts", async (t) => {
    t.mock.method(globalThis, "fetch", async () => { throw new Error("offline fixture") })
    const code = "// work/resumed.ts\nexport const resumed = true;"
    const output = "```typescript\n" + code + "\n```"
    const fixture = path.join(tmp, "resume-child.cjs")
    fs.writeFileSync(fixture, `
      const task = process.argv[2].split("Your node task:\\n").at(-1)
      console.log(task === "work" ? ${JSON.stringify(output)} : "child completed")
    `)
    const run = makeRun({ nodes: [
      { id: "done", task: "Already complete" },
      { id: "work", task: "work", dependsOn: ["done"] },
      { id: "child", task: "child", dependsOn: ["work"] },
    ] })
    run.status = "partial"
    run.executions = 2
    run.nodes[0].state = "done"
    run.nodes[0].output = "already complete"
    run.nodes[0].attempts = 1
    run.nodes[1].state = "failed"
    run.nodes[1].attempts = 1
    run.nodes[1].error = "original failure"
    run.nodes[1].finishedAt = run.createdAt
    run.nodes[2].state = "skipped"
    run.nodes[2].error = "blocked by failed dependency"
    run.nodes[2].finishedAt = run.createdAt
    saveRun(run)

    const originalEntry = process.argv[1]
    const originalDepth = process.env.MOMO_RLM_DEPTH
    const completed: string[] = []
    let resumed: GraphRun | null
    try {
      process.argv[1] = fixture
      process.env.MOMO_RLM_DEPTH = "0"
      resumed = await resumeGraph(run.id, {
        concurrency: 1, timeoutMs: 5000,
        onNode: (node) => { completed.push(node.id) },
      })
    } finally {
      process.argv[1] = originalEntry
      if (originalDepth === undefined) delete process.env.MOMO_RLM_DEPTH
      else process.env.MOMO_RLM_DEPTH = originalDepth
    }

    assert.ok(resumed)
    assert.deepStrictEqual(completed, ["work", "child"])
    assert.strictEqual(resumed.status, "done")
    assert.strictEqual(resumed.executions, 4)
    assert.deepStrictEqual(resumed.nodes.map((n) => n.state), ["done", "done", "done"])
    assert.deepStrictEqual(resumed.nodes.map((n) => n.attempts), [1, 2, 1])
    assert.ok(resumed.nodes.every((n) => n.error === undefined))
    assert.strictEqual(resumed.nodes[0].output, "already complete")
    assert.deepStrictEqual(resumed.nodes[1].artifacts, [{ path: "work/resumed.ts", size: code.length }])
    assert.strictEqual(fs.readFileSync(path.join(getGraphOutputDir(run.id), "work/resumed.ts"), "utf8"), code)
    assert.deepStrictEqual(loadRun(run.id), JSON.parse(JSON.stringify(resumed)))
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

  it("starts dependent work as soon as a slot frees instead of waiting for the batch", async () => {
    // slow(2s) runs in parallel with quick(100ms); `after` depends only on
    // quick. A barrier scheduler holds `after` until slow lands too; a
    // work-conserving scheduler starts it the moment quick finishes.
    const fixture = path.join(tmp, "scheduler-child.cjs")
    fs.writeFileSync(fixture, `
      const task = process.argv[2]
      const m = /sleep-(\\d+)ms/.exec(task)
      if (m) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(m[1]))
      console.log(task + " ok")
    `)
    const run = makeRun({ nodes: [
      { id: "slow", task: "slow sleep-2000ms" },
      { id: "quick", task: "quick sleep-100ms" },
      { id: "after", task: "after sleep-100ms", dependsOn: ["quick"] },
    ] })
    const originalEntry = process.argv[1]
    const originalDepth = process.env.MOMO_RLM_DEPTH
    try {
      process.argv[1] = fixture
      process.env.MOMO_RLM_DEPTH = "0"
      await executeGraph(run, { concurrency: 2, timeoutMs: 15_000 })
    } finally {
      process.argv[1] = originalEntry
      if (originalDepth === undefined) delete process.env.MOMO_RLM_DEPTH
      else process.env.MOMO_RLM_DEPTH = originalDepth
    }

    const byId = new Map(run.nodes.map((n) => [n.id, n]))
    const startedAt = (id: string) => Date.parse(byId.get(id)!.startedAt!)
    const finishedAt = (id: string) => Date.parse(byId.get(id)!.finishedAt!)
    assert.strictEqual(run.status, "done")
    assert.ok(run.nodes.every((n) => n.state === "done"))
    // The dependency edge is respected: `after` starts after `quick` lands.
    assert.ok(startedAt("after") >= finishedAt("quick"))
    // Work conservation: `after` ran while `slow` was still in flight (a
    // 800ms margin against spawn jitter on loaded CI runners).
    assert.ok(startedAt("after") + 800 < finishedAt("slow"))
  })
})
