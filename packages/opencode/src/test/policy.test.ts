import { describe, it } from "node:test"
import assert from "node:assert"
import { Effect } from "effect"
import { Policy, PolicyLive } from "../evolve/policy"
import type { EvalScore } from "../evolve"

describe("policy", () => {
  const score = (opts: Partial<EvalScore> = {}): EvalScore => ({
    passAt1: 0.85,
    regressionCount: 1,
    calibratedConfidence: 0.8,
    safetyScore: 0.96,
    ...opts,
  })

  it("classifies low scores as rebuild-data", async () => {
    const program = Effect.gen(function* () {
      const policy = yield* Policy
      return yield* policy.classify(score({ passAt1: 0.7 }))
    }).pipe(Effect.provide(PolicyLive))

    const action = await Effect.runPromise(program)
    assert.equal(action._tag, "rebuild-data")
  })

  it("classifies moderate scores as tune-hyperparams", async () => {
    const program = Effect.gen(function* () {
      const policy = yield* Policy
      return yield* policy.classify(score({ passAt1: 0.85 }))
    }).pipe(Effect.provide(PolicyLive))

    const action = await Effect.runPromise(program)
    assert.equal(action._tag, "tune-hyperparams")
    if (action._tag === "tune-hyperparams") {
      assert.equal(action.suggestedLoraRank, 16)
      assert.equal(action.suggestedLr, 1e-4)
    }
  })

  it("classifies high scores with few regressions as promote", async () => {
    const program = Effect.gen(function* () {
      const policy = yield* Policy
      return yield* policy.classify(score({ passAt1: 0.97, regressionCount: 1 }))
    }).pipe(Effect.provide(PolicyLive))

    const action = await Effect.runPromise(program)
    assert.equal(action._tag, "promote")
  })

  it("classifies high scores with many regressions as surgical", async () => {
    const program = Effect.gen(function* () {
      const policy = yield* Policy
      return yield* policy.classify(score({ passAt1: 0.97, regressionCount: 5 }))
    }).pipe(Effect.provide(PolicyLive))

    const action = await Effect.runPromise(program)
    assert.equal(action._tag, "surgical")
    if (action._tag === "surgical") {
      assert.ok(Array.isArray(action.targetClusters))
    }
  })

  it("tunes hyperparams on first regression", async () => {
    const program = Effect.gen(function* () {
      const policy = yield* Policy
      yield* policy.classify(score({ passAt1: 0.9 }))
      return yield* policy.classify(score({ passAt1: 0.88 }))
    }).pipe(Effect.provide(PolicyLive))

    const action = await Effect.runPromise(program)
    assert.equal(action._tag, "tune-hyperparams")
    if (action._tag === "tune-hyperparams") {
      assert.equal(action.suggestedLoraRank, 32)
      assert.equal(action.suggestedLr, 1e-4)
    }
  })

  it("triggers rollback after persistent regression", async () => {
    const program = Effect.gen(function* () {
      const policy = yield* Policy
      yield* policy.classify(score({ passAt1: 0.9 }))
      yield* policy.classify(score({ passAt1: 0.88 }))
      yield* policy.classify(score({ passAt1: 0.87 }))
      return yield* policy.classify(score({ passAt1: 0.86 }))
    }).pipe(Effect.provide(PolicyLive))

    const action = await Effect.runPromise(program)
    assert.equal(action._tag, "rollback")
    if (action._tag === "rollback") {
      assert.equal(action.previousScore, 0.9)
      assert.equal(action.currentScore, 0.86)
    }
  })

  it("detects stagnation after regressions", async () => {
    const program = Effect.gen(function* () {
      const policy = yield* Policy
      yield* policy.classify(score({ passAt1: 0.9 }))
      yield* policy.classify(score({ passAt1: 0.89 }))
      yield* policy.classify(score({ passAt1: 0.88 }))
      return yield* policy.isStagnated(2)
    }).pipe(Effect.provide(PolicyLive))

    const stagnated = await Effect.runPromise(program)
    assert.equal(stagnated, true)
  })

  it("records score history", async () => {
    const program = Effect.gen(function* () {
      const policy = yield* Policy
      yield* policy.classify(score({ passAt1: 0.85 }))
      yield* policy.classify(score({ passAt1: 0.9 }))
      return yield* policy.getHistory()
    }).pipe(Effect.provide(PolicyLive))

    const history = await Effect.runPromise(program)
    assert.equal(history.length, 2)
  })

  it("resets internal state", async () => {
    const program = Effect.gen(function* () {
      const policy = yield* Policy
      yield* policy.classify(score({ passAt1: 0.85 }))
      yield* policy.reset()
      return yield* policy.isStagnated(1)
    }).pipe(Effect.provide(PolicyLive))

    const stagnated = await Effect.runPromise(program)
    assert.equal(stagnated, false)
  })
})
