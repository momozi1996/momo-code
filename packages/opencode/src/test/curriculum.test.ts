/**
 * Tests for the evolve curriculum — three-slice training dataset synthesis.
 *
 * Scenarios covered:
 * - Long-term maintainability (4★): stable curriculum with quality controls
 * - Effect/FP enthusiasts (4★): service composition
 */

import { describe, it } from "node:test"
import assert from "node:assert"
import { Effect, Layer } from "effect"
import { Curriculum, CurriculumLive } from "../evolve/curriculum"
import { Store, StoreLive } from "../evolve/store"
import type { DataSpec, TrainingSample, ConfusionCluster } from "../evolve/index"

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

let sampleCounter = 0
function makeSample(overrides: Partial<TrainingSample> = {}): TrainingSample {
  const n = sampleCounter++
  return {
    id: `sample_${Math.random().toString(36).slice(2, 8)}`,
    context: `Fix the auth bug ${n}`,
    action: "Change password validation",
    expected: "Use bcrypt compare",
    verdict: "pass",
    reason: `reason-${n}`,
    source: "sess-1",
    _tag: "gold",
    ...overrides,
  }
}

function makeDataSpec(overrides: Partial<DataSpec> = {}): DataSpec {
  return {
    gold: Array.from({ length: 10 }, () => makeSample({ _tag: "gold" })),
    hardNegatives: Array.from({ length: 6 }, () => makeSample({ _tag: "hard-negative", verdict: "fail" })),
    replay: Array.from({ length: 4 }, () => makeSample({ _tag: "replay" })),
    qualityConstraints: {
      twoForOne: true,
      labelBalance: true,
      contextLengthMatch: true,
      entityDiversity: true,
      cotAnnotated: true,
    },
    ...overrides,
  }
}

function makeCluster(overrides: Partial<ConfusionCluster> = {}): ConfusionCluster {
  return {
    name: "missing-import",
    count: 3,
    avgRetries: 1,
    signals: [],
    fixable: true,
    category: "syntax",
    ...overrides,
  }
}

function runCurriculum<R, E>(program: Effect.Effect<R, E, Curriculum | Store>): Promise<R> {
  const curriculumLayer = Layer.provide(CurriculumLive, StoreLive)
  const layers = Layer.merge(curriculumLayer, StoreLive)
  return Effect.runPromise(Effect.provide(program, layers))
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("curriculum", () => {
  describe("build", () => {
    it("builds a dataset with three slices", async () => {
      const spec = makeDataSpec()

      const program = Effect.gen(function* () {
        const curriculum = yield* Curriculum
        return yield* curriculum.build(spec, { hardNegRatio: 0.3, replay: true })
      })

      const dataset = await runCurriculum(program)
      assert.ok(dataset.length > 0)
      assert.ok(dataset.some((s) => s._tag === "gold"))
      assert.ok(dataset.some((s) => s._tag === "hard-negative"))
      assert.ok(dataset.some((s) => s._tag === "replay"))
    })

    it("applies 2-for-1 pairing for hard negatives", async () => {
      const spec = makeDataSpec({
        gold: [makeSample({ _tag: "gold", context: "x".repeat(50) })],
        hardNegatives: [makeSample({ _tag: "hard-negative", verdict: "fail", context: "x".repeat(52) })],
      })

      const program = Effect.gen(function* () {
        const curriculum = yield* Curriculum
        return yield* curriculum.build(spec, { hardNegRatio: 0.5, replay: false })
      })

      const dataset = await runCurriculum(program)
      const hardNegs = dataset.filter((s) => s._tag === "hard-negative")
      const pairedGolds = dataset.filter((s) => s.id.startsWith("paired-"))
      assert.strictEqual(pairedGolds.length, hardNegs.length)
    })

    it("omits replay slice when disabled", async () => {
      const spec = makeDataSpec()

      const program = Effect.gen(function* () {
        const curriculum = yield* Curriculum
        return yield* curriculum.build(spec, { hardNegRatio: 0.3, replay: false })
      })

      const dataset = await runCurriculum(program)
      assert.ok(!dataset.some((s) => s._tag === "replay"))
    })

    it("records build stats", async () => {
      const spec = makeDataSpec()

      const program = Effect.gen(function* () {
        const curriculum = yield* Curriculum
        yield* curriculum.build(spec, { hardNegRatio: 0.3, replay: true })
        return yield* curriculum.getStats()
      })

      const stats = await runCurriculum(program)
      assert.strictEqual(stats.length, 1)
      assert.strictEqual(stats[0].qualityChecksPassed, 5)
    })
  })

  describe("synthesizeFromClusters", () => {
    it("generates hard-negative samples from fixable clusters", async () => {
      const cluster = makeCluster({
        signals: [
          {
            sessionId: "sess-1",
            toolCallId: "tsc",
            type: "compile-error",
            severity: "high",
            context: "import missing",
          },
        ],
      })

      const program = Effect.gen(function* () {
        const curriculum = yield* Curriculum
        return yield* curriculum.synthesizeFromClusters([cluster], [])
      })

      const samples = await runCurriculum(program)
      assert.strictEqual(samples.length, 1)
      assert.strictEqual(samples[0]._tag, "hard-negative")
      assert.strictEqual(samples[0].verdict, "fail")
      assert.ok(samples[0].expected.includes("import"))
    })

    it("skips non-fixable clusters", async () => {
      const cluster = makeCluster({ name: "external-network", fixable: false, category: "external" })

      const program = Effect.gen(function* () {
        const curriculum = yield* Curriculum
        return yield* curriculum.synthesizeFromClusters([cluster], [])
      })

      const samples = await runCurriculum(program)
      assert.strictEqual(samples.length, 0)
    })
  })
})
