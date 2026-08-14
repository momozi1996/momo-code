/**
 * Tests for the experience selector.
 *
 * Scenarios covered:
 * - Multi-model strategy teams (4★): selection must work across providers/tasks
 * - Long-term maintainability (4★): scope priority and token budgets
 * - Effect/FP enthusiasts (4★): service-based Effect composition
 * - General frontend/full-stack users (3★): default options work out of the box
 */

import { describe, it } from "node:test"
import assert from "node:assert"
import { Effect, Layer } from "effect"
import { Selector, SelectorLive, type TaskContext, type SelectionOpts } from "../experience/selector"
import { ExperienceStore } from "../experience/store"
import { generateTacticId, type Tactic } from "../experience/tactic"
import type { Signal } from "../evolve/signals"
import type { Case, LedgerEntry } from "../experience"

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeSignal(type: Signal["type"], confidence = 0.95, overrides: Partial<Signal> = {}): Signal {
  return {
    sessionId: "sess-test",
    timestamp: new Date(),
    type,
    verdict: type === "test-pass" || type === "edit-accepted" ? "pass" : "fail",
    confidence,
    metadata: { language: "typescript" },
    ...overrides,
  }
}

function makeTactic(overrides: Partial<Tactic> = {}): Tactic {
  const title = overrides.title || "Test Tactic"
  const scope = overrides.scope || "global"
  return {
    id: generateTacticId(scope as Tactic["scope"], title),
    scope: scope as Tactic["scope"],
    intent: "convention",
    title,
    triggers: [{ types: ["test-fail"], minConfidence: 0.5 }],
    preconditions: [],
    steps: ["Step one", "Step two"],
    guardrails: { maxFiles: 10, forbiddenPaths: [".git"], smallestReversible: true },
    checks: [],
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

function mockStore(tactics: Tactic[] = [], cases: Case[] = []) {
  return ExperienceStore.of({
    _tag: "experience/Store" as const,
    loadTactics: () => Effect.succeed(tactics),
    saveTactics: () => Effect.void,
    getCachedTactics: () => Effect.succeed(tactics),
    findTactic: (id: string) => Effect.succeed(tactics.find((t) => t.id === id) ?? null),
    updateTacticStatus: () => Effect.succeed(false),
    loadCases: () => Effect.succeed(cases),
    saveCases: () => Effect.void,
    getCachedCases: () => Effect.succeed(cases),
    appendCase: () => Effect.void,
    appendLedger: () => Effect.void,
    appendLedgerBatch: () => Effect.void,
    loadLedger: () => Effect.succeed([]),
    initialize: () => Effect.succeed({ tactics, cases, ledger: [] }),
    getPaths: () =>
      Effect.succeed({
        dir: "/tmp/momo-test",
        tactics: "/tmp/momo-test/tactics.json",
        cases: "/tmp/momo-test/cases.json",
        ledger: "/tmp/momo-test/ledger.jsonl",
      }),
  })
}

function runSelector<R, E>(tactics: Tactic[], program: Effect.Effect<R, E, Selector>): Promise<R> {
  const layers = Layer.provide(SelectorLive, Layer.succeed(ExperienceStore, mockStore(tactics)))
  return Effect.runPromise(Effect.provide(program, layers))
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("selector", () => {
  describe("rankThompson", () => {
    it("ranks high-performing tactics above low-performing ones on average", async () => {
      const goodTactic = makeTactic({
        title: "Good Tactic",
        stats: { wins: 90, losses: 10, alpha: 91, beta: 11, lastUsed: new Date().toISOString(), uses: 100 },
      })
      const badTactic = makeTactic({
        title: "Bad Tactic",
        stats: { wins: 10, losses: 90, alpha: 11, beta: 91, lastUsed: new Date().toISOString(), uses: 100 },
      })

      const program = Effect.gen(function* () {
        const selector = yield* Selector
        const ctx: TaskContext = { signals: [makeSignal("test-fail")] }
        return yield* selector.rankThompson([goodTactic, badTactic], ctx)
      })

      let goodWins = 0
      const trials = 50
      for (let i = 0; i < trials; i++) {
        const run = await runSelector([goodTactic, badTactic], program)
        if (run[0].tactic.id === goodTactic.id) goodWins++
      }

      assert.ok(
        goodWins > trials * 0.6,
        `Good tactic should be ranked first most of the time (got ${goodWins}/${trials})`,
      )
    })
  })

  describe("rankUcb", () => {
    it("gives unused tactics infinite exploration bonus", async () => {
      const unused = makeTactic({
        title: "Unused Tactic",
        stats: { wins: 0, losses: 0, alpha: 1, beta: 1, lastUsed: new Date().toISOString(), uses: 0 },
      })
      const used = makeTactic({
        title: "Used Tactic",
        stats: { wins: 50, losses: 50, alpha: 51, beta: 51, lastUsed: new Date().toISOString(), uses: 100 },
      })

      const program = Effect.gen(function* () {
        const selector = yield* Selector
        const ctx: TaskContext = { signals: [makeSignal("test-fail")] }
        return yield* selector.rankUcb([unused, used], ctx)
      })

      const ranked = await runSelector([unused, used], program)
      const unusedRank = ranked.find((r) => r.tactic.id === unused.id)
      assert.strictEqual(unusedRank?.rawScore, Number.POSITIVE_INFINITY)
    })

    it("respects scope priority boost", async () => {
      const globalTactic = makeTactic({
        title: "Global",
        scope: "global",
        stats: { wins: 50, losses: 10, alpha: 51, beta: 11, lastUsed: new Date().toISOString(), uses: 60 },
      })
      const repoTactic = makeTactic({
        title: "Repo",
        scope: "repo",
        triggers: [{ types: ["test-fail"], minConfidence: 0.5 }],
        stats: { wins: 50, losses: 10, alpha: 51, beta: 11, lastUsed: new Date().toISOString(), uses: 60 },
      })

      const program = Effect.gen(function* () {
        const selector = yield* Selector
        const ctx: TaskContext = { signals: [makeSignal("test-fail")], repo: "momo-code" }
        return yield* selector.rankUcb([globalTactic, repoTactic], ctx)
      })

      const ranked = await runSelector([globalTactic, repoTactic], program)
      const repo = ranked.find((r) => r.tactic.id === repoTactic.id)
      const global = ranked.find((r) => r.tactic.id === globalTactic.id)
      assert.ok(repo && global, "Both tactics should be ranked")
      assert.strictEqual(repo.scopeBoost, 2.0)
      assert.strictEqual(global.scopeBoost, 1.0)
    })
  })

  describe("scope compatibility", () => {
    it("filters out repo-scoped tactics when repo is missing", async () => {
      const repoTactic = makeTactic({
        title: "Repo Only",
        scope: "repo",
        triggers: [{ types: ["test-fail"], minConfidence: 0.5 }],
      })

      const program = Effect.gen(function* () {
        const selector = yield* Selector
        const ctx: TaskContext = { signals: [makeSignal("test-fail")] }
        return yield* selector.retrieve(ctx)
      })

      const candidates = await runSelector([repoTactic], program)
      assert.strictEqual(candidates.length, 0)
    })

    it("matches lang-scoped tactics when language matches", async () => {
      const tsTactic = makeTactic({
        title: "TypeScript Convention",
        scope: "lang:typescript",
        triggers: [{ types: ["test-fail"], minConfidence: 0.5 }],
      })

      const program = Effect.gen(function* () {
        const selector = yield* Selector
        const ctx: TaskContext = { signals: [makeSignal("test-fail")], language: "typescript" }
        return yield* selector.retrieve(ctx)
      })

      const candidates = await runSelector([tsTactic], program)
      assert.strictEqual(candidates.length, 1)
      assert.strictEqual(candidates[0].id, tsTactic.id)
    })
  })

  describe("token budget", () => {
    it("respects max count k", async () => {
      const many = Array.from({ length: 10 }, (_, i) =>
        makeTactic({
          title: `Tactic ${i}`,
          triggers: [{ types: ["test-fail"], minConfidence: 0.5 }],
          stats: { wins: 10, losses: 0, alpha: 11, beta: 1, lastUsed: new Date().toISOString(), uses: 10 },
        }),
      )

      const program = Effect.gen(function* () {
        const selector = yield* Selector
        const ctx: TaskContext = { signals: [makeSignal("test-fail")] }
        const opts: Partial<SelectionOpts> = { k: 3, method: "ucb", budgetTokens: 10000 }
        return yield* selector.select(ctx, opts)
      })

      const selected = await runSelector(many, program)
      assert.strictEqual(selected.length, 3)
    })
  })
})
