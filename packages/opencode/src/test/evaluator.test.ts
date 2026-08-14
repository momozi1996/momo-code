import { describe, it } from "node:test"
import assert from "node:assert"
import { Effect, Option } from "effect"
import { Evaluator, EvaluatorLive } from "../evolve/evaluator"
import type { MCNode, TrainingPipeline } from "../evolve"

describe("evaluator", () => {
  const makeNode = (modelId: string): MCNode => ({
    id: "node-1",
    pi: {
      D: {
        gold: [],
        hardNegatives: [],
        replay: [],
        qualityConstraints: {
          twoForOne: true,
          labelBalance: true,
          contextLengthMatch: true,
          entityDiversity: true,
          cotAnnotated: true,
        },
      },
      H: {
        baseModel: modelId,
        loraRank: 16,
        learningRate: 2e-4,
        batchSize: 4,
        epochs: 3,
        systemPrompt: "You are an expert coding assistant.",
      },
      S: {
        format: "direct",
        teacherModel: "gpt-4.1",
        evalMethod: "pass@1",
      },
    } as TrainingPipeline,
    score: Option.none(),
    parentId: Option.none(),
    children: [],
    depth: 0,
    visits: 0,
    createdAt: new Date(),
  })

  describe("run", () => {
    it("returns an eval score", async () => {
      const score = await Effect.runPromise(
        Effect.gen(function* () {
          const evaluator = yield* Evaluator
          return yield* evaluator.run("model-a", "momo-bench-v1")
        }).pipe(Effect.provide(EvaluatorLive)),
      )

      assert.ok(score.passAt1 >= 0.82 && score.passAt1 <= 0.98)
      assert.ok(score.calibratedConfidence > 0)
      assert.ok(score.safetyScore >= 0.95)
    })
  })

  describe("runDetailed", () => {
    it("returns per-task results", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const evaluator = yield* Evaluator
          return yield* evaluator.runDetailed("model-b", "momo-bench-v1")
        }).pipe(Effect.provide(EvaluatorLive)),
      )

      assert.equal(result.passedTasks.length + result.failedTasks.length, 320)
      assert.ok(result.score.passAt1 >= 0 && result.score.passAt1 <= 1)
      assert.equal(result.taskDetails.size, 320)
    })

    it("caches results for the same model and eval set", async () => {
      const program = Effect.gen(function* () {
        const evaluator = yield* Evaluator
        const a = yield* evaluator.runDetailed("model-c", "momo-bench-v1")
        const b = yield* evaluator.runDetailed("model-c", "momo-bench-v1")
        return [a, b] as const
      }).pipe(Effect.provide(EvaluatorLive))

      const [first, second] = await Effect.runPromise(program)
      assert.strictEqual(first.score.passAt1, second.score.passAt1)
    })
  })

  describe("ratchetGate", () => {
    it("auto-passes when no checkpoints exist", async () => {
      const ok = await Effect.runPromise(
        Effect.gen(function* () {
          const evaluator = yield* Evaluator
          return yield* evaluator.ratchetGate(makeNode("model-first"), { eps: 2, checkpoints: [] })
        }).pipe(Effect.provide(EvaluatorLive)),
      )

      assert.equal(ok, true)
    })

    it("records checkpoints and lists them", async () => {
      const program = Effect.gen(function* () {
        const evaluator = yield* Evaluator
        const results = new Map<string, boolean>([["task-1", true], ["task-2", false]])
        yield* evaluator.recordCheckpoint("model-prev", results)
        const checkpoints = yield* evaluator.getCheckpoints()
        const history = yield* evaluator.getHistory("model-prev")
        return { checkpoints, history }
      }).pipe(Effect.provide(EvaluatorLive))

      const { checkpoints, history } = await Effect.runPromise(program)

      assert.deepStrictEqual(checkpoints, ["model-prev"])
      assert.equal(history._tag, "Some")
      if (history._tag === "Some") {
        assert.equal(history.value.get("task-1"), true)
        assert.equal(history.value.get("task-2"), false)
      }
    })
  })
})
