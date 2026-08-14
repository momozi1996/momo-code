/**
 * Tests for the experience distiller.
 *
 * Scenarios covered:
 * - Long-term maintainability (4★): tactics distilled from success patterns
 * - Effect/FP enthusiasts (4★): pure-ish service transformation
 */

import { describe, it } from "node:test"
import assert from "node:assert"
import { Effect } from "effect"
import { Distiller, DistillerLive } from "../experience/distiller"
import { SignalScorer } from "../evolve/signals"

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makePassSignal(toolName: string) {
  return { ...SignalScorer.fromExitCode(0, toolName), sessionId: "sess-1" }
}

function makeFailSignal(toolName: string) {
  return { ...SignalScorer.fromExitCode(1, toolName), sessionId: "sess-1" }
}

function runDistiller<R>(program: Effect.Effect<R, never, Distiller>): Promise<R> {
  return Effect.runPromise(Effect.provide(program, DistillerLive))
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("distiller", () => {
  describe("distill", () => {
    it("creates tactics from successful signals", async () => {
      const signals = Array.from({ length: 3 }, () => makePassSignal("bash"))

      const program = Effect.gen(function* () {
        const distiller = yield* Distiller
        return yield* distiller.distill(signals)
      })

      const result = await runDistiller(program)
      assert.ok(result.tactics.length > 0, "Should distill at least one tactic")
      assert.strictEqual(result.newCount, result.tactics.length)
    })

    it("creates negative constraints from failure clusters", async () => {
      const signals = Array.from({ length: 3 }, () => makeFailSignal("bash"))

      const program = Effect.gen(function* () {
        const distiller = yield* Distiller
        return yield* distiller.distill(signals)
      })

      const result = await runDistiller(program)
      assert.ok(result.constraints.length > 0, "Should create negative constraints")
    })

    it("deduplicates identical tactics", async () => {
      const signals = Array.from({ length: 5 }, () => makePassSignal("bash"))

      const program = Effect.gen(function* () {
        const distiller = yield* Distiller
        const first = yield* distiller.distill(signals)
        const second = yield* distiller.distill(signals, {}, first.tactics)
        return { first, second }
      })

      const result = await runDistiller(program)
      assert.strictEqual(result.second.dedupHitCount, result.first.tactics.length)
      assert.strictEqual(result.second.newCount, 0)
    })

    it("produces no tactics with insufficient success signals", async () => {
      const signals = [makePassSignal("bash")]

      const program = Effect.gen(function* () {
        const distiller = yield* Distiller
        return yield* distiller.distill(signals)
      })

      const result = await runDistiller(program)
      assert.strictEqual(result.tactics.length, 0)
    })

    it("maps signal types to tactic intents", async () => {
      const signals = Array.from({ length: 3 }, () => ({
        ...SignalScorer.fromEdit(true),
        sessionId: "sess-1",
      }))

      const program = Effect.gen(function* () {
        const distiller = yield* Distiller
        return yield* distiller.distill(signals)
      })

      const result = await runDistiller(program)
      assert.ok(result.tactics.every((t) => t.intent === "optimize"))
    })
  })

  describe("distillSuccessPattern", () => {
    it("generates deterministic steps for test-pass signals", async () => {
      const signals = Array.from({ length: 3 }, () => makePassSignal("bash"))

      const program = Effect.gen(function* () {
        const distiller = yield* Distiller
        return distiller.distillSuccessPattern(signals, "bash")
      })

      const tactic = await runDistiller(program)
      assert.ok(tactic.steps.includes("Run tests before committing changes"))
      assert.strictEqual(tactic.status, "draft")
      assert.strictEqual(tactic.stats.wins, 3)
    })
  })
})
