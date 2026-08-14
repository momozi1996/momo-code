/**
 * Tests for the experience injector.
 *
 * Scenarios covered:
 * - General frontend/full-stack users (3★): prompt formatting is readable
 * - Long-term maintainability (4★): injected tactics respect budgets and deduplication
 * - Effect/FP enthusiasts (4★): service composition
 */

import { describe, it } from "node:test"
import assert from "node:assert"
import { Effect, Layer } from "effect"
import { Injector, InjectorLive, type InjectOpts } from "../experience/injector"
import { ExperienceStore } from "../experience/store"
import { generateTacticId, type Tactic } from "../experience/tactic"
import type { RankedTactic } from "../experience/selector"
import type { Case } from "../experience/case"

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeTactic(overrides: Partial<Tactic> = {}): Tactic {
  const title = overrides.title || "Test Tactic"
  const scope = overrides.scope || "global"
  return {
    id: generateTacticId(scope as Tactic["scope"], title),
    scope: scope as Tactic["scope"],
    intent: "convention",
    title,
    triggers: [{ types: ["test-fail"], minConfidence: 0.5 }],
    preconditions: ["Code is TypeScript", "Tests exist"],
    steps: ["Run tests", "Fix failures", "Re-run tests"],
    guardrails: { maxFiles: 5, forbiddenPaths: [".git"], smallestReversible: true },
    checks: ["npm test", "npx tsc --noEmit"],
    stats: {
      wins: 5,
      losses: 1,
      alpha: 6,
      beta: 2,
      lastUsed: new Date().toISOString(),
      uses: 6,
    },
    status: "active",
    provenance: { fromSessions: [], createdAt: new Date().toISOString(), scrubbed: true },
    ...overrides,
  } as Tactic
}

function makeRanked(tactic: Tactic, score = 1.0): RankedTactic {
  return {
    tactic,
    rawScore: score,
    scopeBoost: 1.0,
    finalScore: score,
    signalMatched: true,
  }
}

function mockStore() {
  return ExperienceStore.of({
    _tag: "experience/Store" as const,
    loadTactics: () => Effect.succeed([]),
    saveTactics: () => Effect.void,
    getCachedTactics: () => Effect.succeed([]),
    findTactic: () => Effect.succeed(null),
    updateTacticStatus: () => Effect.succeed(false),
    loadCases: () => Effect.succeed([]),
    saveCases: () => Effect.void,
    getCachedCases: () => Effect.succeed([]),
    appendCase: () => Effect.void,
    appendLedger: () => Effect.void,
    appendLedgerBatch: () => Effect.void,
    loadLedger: () => Effect.succeed([]),
    initialize: () => Effect.succeed({ tactics: [], cases: [], ledger: [] }),
    getPaths: () =>
      Effect.succeed({
        dir: "/tmp/momo-test",
        tactics: "/tmp/momo-test/tactics.json",
        cases: "/tmp/momo-test/cases.json",
        ledger: "/tmp/momo-test/ledger.jsonl",
      }),
  })
}

function runInjector<R, E>(program: Effect.Effect<R, E, Injector>): Promise<R> {
  const layers = Layer.provide(InjectorLive, Layer.succeed(ExperienceStore, mockStore()))
  return Effect.runPromise(Effect.provide(program, layers))
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("injector", () => {
  describe("formatTactic", () => {
    it("includes title, steps, checks and guardrails", async () => {
      const tactic = makeTactic({ title: "Run Tests Before Commit" })

      const program = Effect.gen(function* () {
        const injector = yield* Injector
        return yield* injector.formatTactic(tactic)
      })

      const formatted = await runInjector(program)
      assert.ok(formatted.includes("### Run Tests Before Commit"))
      assert.ok(formatted.includes("**Steps:**"))
      assert.ok(formatted.includes("1. Run tests"))
      assert.ok(formatted.includes("**Checks:**"))
      assert.ok(formatted.includes("- npm test"))
      assert.ok(formatted.includes("**Guardrails:**"))
      assert.ok(formatted.includes("Max files: 5"))
      assert.ok(formatted.includes("win rate:"))
    })

    it("omits checks and guardrails when disabled", async () => {
      const tactic = makeTactic({ title: "Minimal" })

      const program = Effect.gen(function* () {
        const injector = yield* Injector
        return yield* injector.formatTactic(tactic, {
          includeChecks: false,
          includeGuardrails: false,
        } as InjectOpts)
      })

      const formatted = await runInjector(program)
      assert.ok(!formatted.includes("**Checks:**"))
      assert.ok(!formatted.includes("**Guardrails:**"))
    })
  })

  describe("toPromptBlock", () => {
    it("returns empty result when no tactics provided", async () => {
      const program = Effect.gen(function* () {
        const injector = yield* Injector
        return yield* injector.toPromptBlock([])
      })

      const result = await runInjector(program)
      assert.strictEqual(result.block, "")
      assert.strictEqual(result.tacticIds.length, 0)
      assert.strictEqual(result.estimatedTokens, 0)
    })

    it("includes all tactic IDs when budget is sufficient", async () => {
      const tactics = [makeTactic({ title: "A" }), makeTactic({ title: "B" })]

      const program = Effect.gen(function* () {
        const injector = yield* Injector
        return yield* injector.toPromptBlock(tactics.map(makeRanked))
      })

      const result = await runInjector(program)
      assert.strictEqual(result.tacticIds.length, 2)
      assert.ok(result.block.includes("## Learned Tactics"))
      assert.ok(result.block.includes("### A"))
      assert.ok(result.block.includes("### B"))
      assert.ok(result.estimatedTokens > 0)
    })
  })

  describe("injectIntoPrompt", () => {
    it("appends tactic block to system prompt", async () => {
      const systemPrompt = "You are a helpful coding assistant."
      const block = "## Learned Tactics\n\nTactic content"

      const program = Effect.gen(function* () {
        const injector = yield* Injector
        return yield* injector.injectIntoPrompt(block, systemPrompt)
      })

      const result = await runInjector(program)
      assert.ok(result.includes(systemPrompt))
      assert.ok(result.includes(block))
      assert.ok(result.includes("---"))
    })

    it("replaces existing tactic block instead of duplicating", async () => {
      const systemPrompt = "You are helpful.\n\n## Learned Tactics\n\nOld content"
      const block = "## Learned Tactics\n\nNew content"

      const program = Effect.gen(function* () {
        const injector = yield* Injector
        return yield* injector.injectIntoPrompt(block, systemPrompt)
      })

      const result = await runInjector(program)
      const count = (result.match(/## Learned Tactics/g) || []).length
      assert.strictEqual(count, 1)
      assert.ok(result.includes("New content"))
      assert.ok(!result.includes("Old content"))
    })

    it("returns original prompt when block is empty", async () => {
      const systemPrompt = "You are helpful."

      const program = Effect.gen(function* () {
        const injector = yield* Injector
        return yield* injector.injectIntoPrompt("", systemPrompt)
      })

      const result = await runInjector(program)
      assert.strictEqual(result, systemPrompt)
    })
  })

  describe("estimateTokens", () => {
    it("uses rough character-to-token heuristic", async () => {
      const program = Effect.gen(function* () {
        const injector = yield* Injector
        return injector.estimateTokens("abcd")
      })

      const tokens = await runInjector(program)
      assert.strictEqual(tokens, 1)
    })
  })
})
