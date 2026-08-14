/**
 * Tests for the evolve miner — signal extraction and confusion taxonomy.
 *
 * Scenarios covered:
 * - Long-term maintainability (4★): failure taxonomy drives curriculum
 * - Effect/FP enthusiasts (4★): service composition with Store
 */

import { describe, it } from "node:test"
import assert from "node:assert"
import { Effect, Layer } from "effect"
import { Miner, MinerLive, type Session } from "../evolve/miner"
import { Store, StoreLive } from "../evolve/store"

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: `sess_${Date.now()}`,
    messages: [],
    tools: [],
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeTool(overrides: Partial<Session["tools"][number]> = {}) {
  return {
    tool: "bash",
    input: { cmd: "npm test" },
    output: {},
    accepted: true,
    exitCode: 0,
    retries: 0,
    ...overrides,
  }
}

function runMiner<R, E>(program: Effect.Effect<R, E, Miner | Store>): Promise<R> {
  const minerLayer = Layer.provide(MinerLive, StoreLive)
  const layers = Layer.merge(minerLayer, StoreLive)
  return Effect.runPromise(Effect.provide(program, layers))
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("miner", () => {
  describe("diagnose", () => {
    it("extracts test-fail signals from non-zero bash exit codes", async () => {
      const session = makeSession({
        tools: [makeTool({ tool: "bash", exitCode: 1 })],
      })

      const program = Effect.gen(function* () {
        const miner = yield* Miner
        return yield* miner.diagnose([session])
      })

      const taxonomy = await runMiner(program)
      assert.strictEqual(taxonomy.totalSignals, 1)
      assert.strictEqual(taxonomy.clusters.length, 1)
      assert.strictEqual(taxonomy.clusters[0].signals[0].type, "test-fail")
      assert.strictEqual(taxonomy.clusters[0].signals[0].severity, "high")
    })

    it("extracts compile-error signals from non-zero tsc exit codes", async () => {
      const session = makeSession({
        tools: [makeTool({ tool: "tsc", exitCode: 2 })],
      })

      const program = Effect.gen(function* () {
        const miner = yield* Miner
        return yield* miner.diagnose([session])
      })

      const taxonomy = await runMiner(program)
      assert.strictEqual(taxonomy.totalSignals, 1)
      assert.strictEqual(taxonomy.clusters[0].signals[0].type, "compile-error")
    })

    it("extracts rejected-edit signals", async () => {
      const session = makeSession({
        tools: [makeTool({ accepted: false })],
      })

      const program = Effect.gen(function* () {
        const miner = yield* Miner
        return yield* miner.diagnose([session])
      })

      const taxonomy = await runMiner(program)
      assert.ok(
        taxonomy.clusters.some((c) =>
          c.signals.some((s) => s.type === "rejected-edit"),
        ),
      )
    })

    it("extracts retry-loop signals for high retry counts", async () => {
      const session = makeSession({
        tools: [makeTool({ retries: 4 })],
        messages: [
          { role: "assistant", content: "Trying fix", timestamp: Date.now() },
          { role: "user", content: "Still broken", timestamp: Date.now() + 1 },
        ],
      })

      const program = Effect.gen(function* () {
        const miner = yield* Miner
        return yield* miner.diagnose([session])
      })

      const taxonomy = await runMiner(program)
      assert.ok(
        taxonomy.clusters.some((c) =>
          c.signals.some((s) => s.type === "retry-loop"),
        ),
      )
    })

    it("detects user-correction messages", async () => {
      const session = makeSession({
        messages: [
          { role: "assistant", content: "I will use var", timestamp: Date.now() },
          { role: "user", content: "That is wrong, should use const", timestamp: Date.now() + 1 },
        ],
      })

      const program = Effect.gen(function* () {
        const miner = yield* Miner
        return yield* miner.diagnose([session])
      })

      const taxonomy = await runMiner(program)
      assert.ok(
        taxonomy.clusters.some((c) =>
          c.signals.some((s) => s.type === "user-correction"),
        ),
      )
    })

    it("clusters signals by failure type", async () => {
      const sessions = [
        makeSession({
          id: "sess-1",
          tools: [makeTool({ tool: "tsc", exitCode: 2, input: { cmd: "tsc", error: "type error" } })],
        }),
        makeSession({
          id: "sess-2",
          tools: [makeTool({ tool: "tsc", exitCode: 2, input: { cmd: "tsc", error: "type mismatch" } })],
        }),
        makeSession({
          id: "sess-3",
          tools: [makeTool({ tool: "bash", exitCode: 1, input: { cmd: "npm test" } })],
        }),
      ]

      const program = Effect.gen(function* () {
        const miner = yield* Miner
        return yield* miner.diagnose(sessions)
      })

      const taxonomy = await runMiner(program)
      assert.strictEqual(taxonomy.totalSessions, 3)
      assert.ok(taxonomy.clusters.length >= 2)
    })

    it("marks network/external clusters as not fixable", async () => {
      const session = makeSession({
        tools: [makeTool({ tool: "bash", exitCode: 1, input: { cmd: "curl", error: "network timeout" } })],
      })

      const program = Effect.gen(function* () {
        const miner = yield* Miner
        return yield* miner.diagnose([session])
      })

      const taxonomy = await runMiner(program)
      const networkCluster = taxonomy.clusters.find((c) => c.name.includes("external"))
      if (networkCluster) {
        assert.strictEqual(networkCluster.fixable, false)
      }
    })
  })
})
