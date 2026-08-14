import { describe, it } from "node:test"
import assert from "node:assert"
import { Effect, Option } from "effect"
import { Search, SearchLive } from "../evolve/search"
import type { MCNode, Taxonomy, TrainingPipeline, EvalScore, TrainingJob } from "../evolve"

describe("search", () => {
  const makeTaxonomy = (overrides: Partial<Taxonomy> = {}): Taxonomy => ({
    clusters: [
      {
        name: "missing-import",
        count: 3,
        signals: [],
        category: "syntax",
        avgRetries: 1.2,
        fixable: true,
      },
      {
        name: "logic-error",
        count: 2,
        signals: [],
        category: "logic",
        avgRetries: 2.0,
        fixable: true,
      },
      {
        name: "semantic-gap",
        count: 2,
        signals: [],
        category: "semantic",
        avgRetries: 1.5,
        fixable: true,
      },
    ],
    totalSessions: 10,
    totalSignals: 7,
    fixableRatio: 1.0,
    ...overrides,
  })

  const run = <A>(effect: Effect.Effect<A, never, Search>) =>
    Effect.runPromise(effect.pipe(Effect.provide(SearchLive)))

  describe("init", () => {
    it("creates a graph with a root node", async () => {
      const graph = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.init({ root: "gpt-4o-mini" })
      }))

      assert.equal(graph.nodes.has(graph.rootId), true)
      const root = graph.nodes.get(graph.rootId)!
      assert.equal(root.depth, 0)
      assert.equal(root.visits, 0)
      assert.equal(root.score._tag, "None")
      assert.equal(root.pi.H.baseModel, "gpt-4o-mini")
      assert.equal(root.pi.S.format, "direct")
    })
  })

  describe("selectUCT", () => {
    it("selects the root from a fresh graph", async () => {
      const graph = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.init({ root: "gpt-4o-mini" })
      }))

      const selected = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.selectUCT(graph)
      }))

      assert.equal(selected.id, graph.rootId)
    })
  })

  describe("expand", () => {
    it("generates children for non-empty taxonomy", async () => {
      const graph = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.init({ root: "gpt-4o-mini" })
      }))
      const root = graph.nodes.get(graph.rootId)!

      const children = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.expand(root, makeTaxonomy())
      }))

      assert.ok(children.length > 0)
      assert.ok(children.some((c) => c.pi.D.qualityConstraints.twoForOne))
      assert.ok(children.some((c) => c.pi.H.loraRank > root.pi.H.loraRank))
      assert.ok(children.some((c) => c.pi.S.format === "cot"))
    })

    it("returns no children for empty taxonomy", async () => {
      const graph = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.init({ root: "gpt-4o-mini" })
      }))
      const root = graph.nodes.get(graph.rootId)!

      const children = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.expand(root, makeTaxonomy({ clusters: [] }))
      }))

      assert.equal(children.length, 0)
    })
  })

  describe("addNode", () => {
    it("adds a scored node and updates best", async () => {
      const graph = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.init({ root: "gpt-4o-mini" })
      }))
      const root = graph.nodes.get(graph.rootId)!

      const score: EvalScore = {
        passAt1: 0.85,
        regressionCount: 1,
        calibratedConfidence: 0.8,
        safetyScore: 0.96,
      }

      const job: TrainingJob = {
        id: "job-1",
        modelId: "gpt-4o-mini@ft-1",
        status: "completed",
        datasetSize: 100,
        hparams: root.pi.H,
      }

      await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.addNode(graph, {
          pi: root.pi,
          f: score,
          job,
          parentId: root.id,
        })
      }))

      const updatedRoot = graph.nodes.get(root.id)!
      assert.equal(updatedRoot.children.length, 1)
      assert.equal(updatedRoot.visits, 1)
      assert.equal(graph.bestNodeId._tag, "Some")
      assert.equal(graph.iteration, 1)
      assert.ok(graph.budgetUsed > 0)
    })

    it("warns when parent is missing", async () => {
      const graph = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.init({ root: "gpt-4o-mini" })
      }))

      const score: EvalScore = {
        passAt1: 0.9,
        regressionCount: 0,
        calibratedConfidence: 0.85,
        safetyScore: 0.97,
      }

      const job: TrainingJob = {
        id: "job-2",
        modelId: "gpt-4o-mini@ft-2",
        status: "completed",
        datasetSize: 100,
        hparams: graph.nodes.get(graph.rootId)!.pi.H,
      }

      await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.addNode(graph, {
          pi: graph.nodes.get(graph.rootId)!.pi,
          f: score,
          job,
          parentId: "missing-parent",
        })
      }))

      assert.equal(graph.nodes.size, 1)
    })
  })

  describe("best", () => {
    it("returns root when no best node exists", async () => {
      const graph = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.init({ root: "gpt-4o-mini" })
      }))

      const best = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.best(graph)
      }))

      assert.equal(best.id, graph.rootId)
    })
  })

  describe("shouldContinue", () => {
    it("returns true within budget and iterations", async () => {
      const graph = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.init({ root: "gpt-4o-mini" })
      }))

      const ok = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.shouldContinue(graph, 100, 10)
      }))

      assert.equal(ok, true)
    })

    it("returns false when budget exhausted", async () => {
      const graph = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.init({ root: "gpt-4o-mini" })
      }))
      graph.budgetUsed = 100

      const ok = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.shouldContinue(graph, 100, 10)
      }))

      assert.equal(ok, false)
    })

    it("returns false when iterations exhausted", async () => {
      const graph = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.init({ root: "gpt-4o-mini" })
      }))
      graph.iteration = 10

      const ok = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.shouldContinue(graph, 100, 10)
      }))

      assert.equal(ok, false)
    })
  })

  describe("fuseOrEvolve", () => {
    it("mutates when there are not enough high-scoring leaves", async () => {
      const graph = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.init({ root: "gpt-4o-mini" })
      }))

      const initialSize = graph.nodes.size

      await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.fuseOrEvolve(graph)
      }))

      assert.equal(graph.nodes.size, initialSize + 1)
    })
  })

  describe("prune", () => {
    it("removes low-scoring leaf nodes", async () => {
      const graph = await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.init({ root: "gpt-4o-mini" })
      }))

      const root = graph.nodes.get(graph.rootId)!
      const childId = "child-low"
      const child: MCNode = {
        id: childId,
        pi: root.pi,
        score: Option.some({
          passAt1: 0.3,
          regressionCount: 5,
          calibratedConfidence: 0.25,
          safetyScore: 0.9,
        }),
        parentId: Option.some(root.id),
        children: [],
        depth: 1,
        visits: 1,
        createdAt: new Date(),
      }
      graph.nodes.set(root.id, { ...root, children: [...root.children, childId] })
      graph.nodes.set(childId, child)

      await run(Effect.gen(function* () {
        const search = yield* Search
        return yield* search.prune(graph, 0.5)
      }))

      assert.equal(graph.nodes.has(childId), false)
    })
  })
})
