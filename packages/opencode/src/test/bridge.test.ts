/**
 * Tests for the experience → evolve bridge.
 *
 * Scenarios covered:
 * - Long-term maintainability (4★): promoted tactics feed fine-tune curriculum
 * - Effect/FP enthusiasts (4★): multi-service composition with guards
 */

import { describe, it, before } from "node:test"
import assert from "node:assert"
import { Effect, Layer } from "effect"
import { Bridge, BridgeLive, InsufficientCasesError } from "../experience/bridge"
import { ExperienceStore, ExperienceStoreLive } from "../experience/store"
import { ExperienceGuardLive } from "../experience/guard"
import { generateTacticId, type Tactic } from "../experience/tactic"
import type { Case } from "../experience/case"
import { SignalScorer } from "../evolve/signals"

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeTactic(status: Tactic["status"] = "promoted", overrides: Partial<Tactic> = {}): Tactic {
  const title = overrides.title || "Promoted Tactic"
  return {
    id: generateTacticId("global", title),
    scope: "global",
    intent: "convention",
    title,
    triggers: [],
    preconditions: [],
    steps: ["Step one", "Step two"],
    guardrails: { maxFiles: 5, forbiddenPaths: [".git"], smallestReversible: true },
    checks: [],
    stats: {
      wins: 10,
      losses: 1,
      alpha: 11,
      beta: 2,
      lastUsed: new Date().toISOString(),
      uses: 11,
    },
    status,
    provenance: { fromSessions: [], createdAt: new Date().toISOString(), scrubbed: true },
    ...overrides,
  } as Tactic
}

function makeCase(tacticId: string, verdict: Case["verdict"] = "pass"): Case {
  return {
    id: `case_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    taskSignature: "task-1",
    sessionId: "sess-1",
    tacticIds: [tacticId],
    verdict,
    metrics: { durationMs: 1000, toolCalls: 5, retries: 0 },
    signals: [{ ...SignalScorer.fromExitCode(0, "bash"), sessionId: "sess-1" }],
    createdAt: new Date().toISOString(),
    scrubbed: true,
  }
}

function makeLayers() {
  const bridgeLayer = Layer.provide(BridgeLive, ExperienceStoreLive)
  return Layer.provide(Layer.merge(bridgeLayer, ExperienceStoreLive), ExperienceGuardLive)
}

function runBridge<R, E>(program: Effect.Effect<R, E, Bridge | ExperienceStore>): Promise<R> {
  return Effect.runPromise(Effect.provide(program, makeLayers()))
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("bridge", () => {
  before(() => {
    process.env.MOMO_CONFIG_DIR = "D:\\githbi\\momo-code\\packages\\opencode\\.test-momo"
  })

  describe("enqueueForFineTune", () => {
    it("skips non-promoted tactics", async () => {
      const tactic = makeTactic("active")

      const program = Effect.gen(function* () {
        const bridge = yield* Bridge
        return yield* bridge.enqueueForFineTune(tactic)
      })

      const count = await runBridge(program)
      assert.strictEqual(count, 0)
    })

    it("enqueues cases for promoted tactics", async () => {
      const tactic = makeTactic("promoted")
      const cases = [makeCase(tactic.id, "pass"), makeCase(tactic.id, "fail")]

      const program = Effect.gen(function* () {
        const store = yield* ExperienceStore
        yield* store.saveCases(cases)
        const bridge = yield* Bridge
        return yield* bridge.enqueueForFineTune(tactic)
      })

      const count = await runBridge(program)
      assert.strictEqual(count, 2)
    })
  })

  describe("buildTrainingSamples", () => {
    it("produces gold samples from passing cases", async () => {
      const tactic = makeTactic("promoted")
      const cases = [makeCase(tactic.id, "pass")]

      const program = Effect.gen(function* () {
        const bridge = yield* Bridge
        return yield* bridge.buildTrainingSamples(cases, [tactic])
      })

      const samples = await runBridge(program)
      assert.strictEqual(samples.gold.length, 1)
      assert.strictEqual(samples.gold[0]._tag, "gold")
      assert.strictEqual(samples.gold[0].verdict, "pass")
    })

    it("produces hard-negative samples from failing cases", async () => {
      const tactic = makeTactic("promoted")
      const cases = [makeCase(tactic.id, "fail")]

      const program = Effect.gen(function* () {
        const bridge = yield* Bridge
        return yield* bridge.buildTrainingSamples(cases, [tactic])
      })

      const samples = await runBridge(program)
      assert.strictEqual(samples.hardNegatives.length, 1)
      assert.strictEqual(samples.hardNegatives[0]._tag, "hard-negative")
      assert.strictEqual(samples.hardNegatives[0].verdict, "fail")
    })

    it("produces replay samples from promoted tactics", async () => {
      const tactic = makeTactic("promoted")
      const cases: Case[] = []

      const program = Effect.gen(function* () {
        const bridge = yield* Bridge
        return yield* bridge.buildTrainingSamples(cases, [tactic])
      })

      const samples = await runBridge(program)
      assert.strictEqual(samples.replay.length, 1)
      assert.strictEqual(samples.replay[0]._tag, "replay")
    })
  })

  describe("spilloverToCurriculum", () => {
    it("fails when there are not enough pass cases", async () => {
      const program = Effect.gen(function* () {
        const bridge = yield* Bridge
        return yield* bridge.spilloverToCurriculum()
      })

      const result = await runBridge(Effect.either(program))
      assert.strictEqual(result._tag, "Left")
      if (result._tag === "Left") {
        assert.ok(result.left instanceof InsufficientCasesError)
      }
    })

    it("records spillover when threshold is met", async () => {
      const tactic = makeTactic("promoted")
      const cases = Array.from({ length: 10 }, () => makeCase(tactic.id, "pass"))

      const program = Effect.gen(function* () {
        const store = yield* ExperienceStore
        yield* store.saveCases(cases)
        const bridge = yield* Bridge
        yield* bridge.enqueueForFineTune(tactic)
        return yield* bridge.spilloverToCurriculum()
      })

      const count = await runBridge(program)
      assert.ok(count > 0)

      const stats = await runBridge(
        Effect.gen(function* () {
          const bridge = yield* Bridge
          return yield* bridge.getPendingStats()
        }),
      )
      assert.strictEqual(stats.pendingCases, 0)
      assert.strictEqual(stats.pendingTactics, 0)
    })
  })
})
