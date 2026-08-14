import { describe, it } from "node:test"
import assert from "node:assert"
import { Effect, Option } from "effect"
import { Store, StoreLive } from "../evolve/store"
import type { SessionRecord, TrainingJob, MCGraph, TrainingSample } from "../evolve"

describe("store", () => {
  const makeSession = (overrides: Partial<SessionRecord> = {}): SessionRecord => ({
    id: "session-1",
    messages: [],
    tools: [],
    createdAt: Date.now(),
    ...overrides,
  })

  const makeJob = (overrides: Partial<TrainingJob> = {}): TrainingJob => ({
    id: "job-1",
    modelId: "model-1",
    status: "queued",
    datasetSize: 100,
    hparams: {
      baseModel: "gpt-4o-mini",
      loraRank: 16,
      learningRate: 2e-4,
      batchSize: 4,
      epochs: 3,
      systemPrompt: "You are a helpful coding assistant.",
    },
    ...overrides,
  })

  const makeGraph = (): MCGraph => {
    const rootId = "root-1"
    return {
      nodes: new Map([
        [rootId, {
          id: rootId,
          pi: {} as any,
          score: Option.none(),
          parentId: Option.none(),
          children: [],
          depth: 0,
          visits: 0,
          createdAt: new Date(),
        }],
      ]),
      rootId,
      bestNodeId: Option.none(),
      iteration: 0,
      budgetUsed: 0,
    }
  }

  describe("sessions", () => {
    it("loads recent sessions within the cutoff", async () => {
      const program = Effect.gen(function* () {
        const store = yield* Store
        yield* store.insertSessions([
          makeSession({ id: "old", createdAt: Date.now() - 10 * 24 * 60 * 60 * 1000 }),
          makeSession({ id: "new", createdAt: Date.now() }),
        ])
        return yield* store.recentSessions({ days: 7, limit: 10 })
      }).pipe(Effect.provide(StoreLive))

      const sessions = await Effect.runPromise(program)
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].id, "new")
    })

    it("respects the limit", async () => {
      const program = Effect.gen(function* () {
        const store = yield* Store
        yield* store.insertSessions([
          makeSession({ id: "a" }),
          makeSession({ id: "b" }),
          makeSession({ id: "c" }),
        ])
        return yield* store.recentSessions({ days: 7, limit: 2 })
      }).pipe(Effect.provide(StoreLive))

      const sessions = await Effect.runPromise(program)
      assert.equal(sessions.length, 2)
    })
  })

  describe("jobs", () => {
    it("saves and retrieves jobs", async () => {
      const program = Effect.gen(function* () {
        const store = yield* Store
        yield* store.saveJob(makeJob({ id: "job-a" }))
        yield* store.saveJob(makeJob({ id: "job-b" }))
        const current = yield* store.currentJob()
        const all = yield* store.allJobs()
        return { current, all }
      }).pipe(Effect.provide(StoreLive))

      const { current, all } = await Effect.runPromise(program)
      assert.equal(current?.id, "job-b")
      assert.equal(all.length, 2)
    })

    it("updates job status", async () => {
      const program = Effect.gen(function* () {
        const store = yield* Store
        yield* store.saveJob(makeJob({ id: "job-c" }))
        yield* store.updateJob("job-c", { status: "completed", completedAt: new Date() })
        return yield* store.currentJob()
      }).pipe(Effect.provide(StoreLive))

      const current = await Effect.runPromise(program)
      assert.equal(current?.status, "completed")
      assert.ok(current?.completedAt)
    })
  })

  describe("graph", () => {
    it("saves and loads graph state", async () => {
      const program = Effect.gen(function* () {
        const store = yield* Store
        yield* store.saveGraph(makeGraph())
        return yield* store.loadGraph()
      }).pipe(Effect.provide(StoreLive))

      const graphOpt = await Effect.runPromise(program)
      assert.equal(graphOpt._tag, "Some")
      if (graphOpt._tag === "Some") {
        assert.equal(graphOpt.value.rootId, "root-1")
        assert.equal(graphOpt.value.nodes.size, 1)
      }
    })
  })

  describe("checkpoints", () => {
    it("saves and loads checkpoints", async () => {
      const program = Effect.gen(function* () {
        const store = yield* Store
        const results = new Map<string, boolean>([["task-1", true]])
        yield* store.saveCheckpoint({ modelId: "model-a", results })
        return yield* store.loadCheckpoints()
      }).pipe(Effect.provide(StoreLive))

      const checkpoints = await Effect.runPromise(program)
      assert.equal(checkpoints.length, 1)
      assert.equal(checkpoints[0].modelId, "model-a")
      assert.equal(checkpoints[0].results.get("task-1"), true)
    })
  })

  describe("dataset", () => {
    it("saves a dataset snapshot", async () => {
      const program = Effect.gen(function* () {
        const store = yield* Store
        const samples: TrainingSample[] = [
          { id: "g1", context: "a", action: "edit", expected: "b", verdict: "pass", source: "s1", _tag: "gold" },
          { id: "h1", context: "c", action: "edit", expected: "d", verdict: "fail", source: "s1", _tag: "hard-negative" },
        ]
        return yield* store.saveDataset("v1", samples)
      }).pipe(Effect.provide(StoreLive))

      const snapshot = await Effect.runPromise(program)
      assert.equal(snapshot.version, "v1")
      assert.equal(snapshot.count, 2)
      assert.equal(snapshot.slices.gold, 1)
      assert.equal(snapshot.slices.hardNegative, 1)
      assert.equal(snapshot.slices.replay, 0)
    })
  })
})
