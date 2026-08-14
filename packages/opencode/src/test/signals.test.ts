/**
 * Tests for signals and verdict computation.
 *
 * Scenarios covered:
 * - General frontend/full-stack users (3★): objective signals from tests/compiles
 * - Long-term maintainability (4★): signal patterns drive tactic activation
 * - Multi-model strategy teams (4★): consistent signal semantics across providers
 */

import { describe, it } from "node:test"
import assert from "node:assert"
import { matchSignalPattern, type SignalPattern } from "../experience/signals"
import { SignalScorer, Signals, type Signal, type Verdict } from "../evolve/signals"
import { computeVerdict, signalMatchesPattern } from "../experience/collector"

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeSignal(type: ReturnType<typeof SignalScorer.fromExitCode>["type"], confidence = 0.95): Signal {
  return {
    sessionId: "sess-test",
    timestamp: new Date(),
    type,
    verdict: type === "test-pass" || type === "edit-accepted" ? "pass" : "fail",
    confidence,
    metadata: { toolName: "bash", exitCode: type === "test-pass" ? 0 : 1, language: "typescript" },
  }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("signals", () => {
  describe("SignalScorer factories", () => {
    it("fromExitCode creates pass signal for exit 0", () => {
      const signal = SignalScorer.fromExitCode(0, "bash")
      assert.strictEqual(signal.type, "test-pass")
      assert.strictEqual(signal.verdict, "pass")
      assert.strictEqual(signal.confidence, 0.95)
    })

    it("fromExitCode creates fail signal for non-zero bash exit", () => {
      const signal = SignalScorer.fromExitCode(1, "bash")
      assert.strictEqual(signal.type, "test-fail")
      assert.strictEqual(signal.verdict, "fail")
    })

    it("fromExitCode creates compile-error for non-zero tsc exit", () => {
      const signal = SignalScorer.fromExitCode(2, "tsc")
      assert.strictEqual(signal.type, "compile-error")
      assert.strictEqual(signal.verdict, "fail")
    })

    it("fromEdit creates accepted/rejected signals", () => {
      const accepted = SignalScorer.fromEdit(true)
      assert.strictEqual(accepted.type, "edit-accepted")
      assert.strictEqual(accepted.verdict, "pass")

      const rejected = SignalScorer.fromEdit(false)
      assert.strictEqual(rejected.type, "edit-rejected")
      assert.strictEqual(rejected.verdict, "fail")
    })

    it("fromRetries escalates verdict with retry count", () => {
      const low = SignalScorer.fromRetries(1)
      assert.strictEqual(low.verdict, "partial")

      const high = SignalScorer.fromRetries(5)
      assert.strictEqual(high.verdict, "fail")
      assert.ok(high.confidence > 0.5)
    })

    it("fromCorrection creates a user-correction signal", () => {
      const signal = SignalScorer.fromCorrection("actually use const")
      assert.strictEqual(signal.type, "user-correction")
      assert.strictEqual(signal.verdict, "fail")
      assert.strictEqual(signal.confidence, 0.85)
      assert.strictEqual(signal.metadata.userMessage, "actually use const")
    })

    it("fromPostHocEdit creates a post-hoc-edit signal", () => {
      const signal = SignalScorer.fromPostHocEdit("var x = 1", "const x = 1")
      assert.strictEqual(signal.type, "post-hoc-edit")
      assert.strictEqual(signal.verdict, "fail")
      assert.ok(signal.metadata.userMessage?.includes("Original:"))
      assert.ok(signal.metadata.userMessage?.includes("Corrected:"))
    })
  })

  describe("scoreSessionQuality", () => {
    it("returns higher score for passing sessions", () => {
      const passing = [
        SignalScorer.fromExitCode(0, "bash"),
        SignalScorer.fromEdit(true),
      ]
      const failing = [
        SignalScorer.fromExitCode(1, "bash"),
        SignalScorer.fromCorrection("fix this"),
      ]

      assert.ok(Signals.scoreSessionQuality(passing) > Signals.scoreSessionQuality(failing))
    })

    it("returns 0.5 for empty signals", () => {
      assert.strictEqual(Signals.scoreSessionQuality([]), 0.5)
    })

    it("returns a high score for all-positive signals", () => {
      const signals = [
        SignalScorer.fromExitCode(0, "bash"),
        SignalScorer.fromEdit(true),
      ]
      assert.ok(Signals.scoreSessionQuality(signals) > 0.9)
    })

    it("returns a low score for all-negative signals", () => {
      const signals = [
        SignalScorer.fromExitCode(1, "bash"),
        SignalScorer.fromCorrection("fix"),
      ]
      assert.ok(Signals.scoreSessionQuality(signals) < 0.2)
    })

    it("clips scores to [0, 1]", () => {
      const veryBad = Array.from({ length: 10 }, () => SignalScorer.fromCorrection("x"))
      assert.strictEqual(Signals.scoreSessionQuality(veryBad), 0)

      const veryGood = Array.from({ length: 10 }, () => SignalScorer.fromExitCode(0, "bash"))
      assert.strictEqual(Signals.scoreSessionQuality(veryGood), 1)
    })
  })

  describe("training pair helpers", () => {
    it("createTrainingPair returns rejected and chosen", () => {
      const rejected = { context: "ctx", action: "bad", reason: "wrong" }
      const chosen = { context: "ctx", action: "good" }
      const pair = Signals.createTrainingPair(rejected, chosen)
      assert.strictEqual(pair.rejected, rejected)
      assert.strictEqual(pair.chosen, chosen)
    })

    it("createDpoPair returns prompt/rejected/chosen/cluster", () => {
      const pair = Signals.createDpoPair("prompt", "bad", "good", "type-error")
      assert.strictEqual(pair.prompt, "prompt")
      assert.strictEqual(pair.rejected, "bad")
      assert.strictEqual(pair.chosen, "good")
      assert.strictEqual(pair.cluster, "type-error")
    })
  })

  describe("computeVerdict", () => {
    it("returns pass when pass signals dominate", () => {
      const signals = [
        makeSignal("test-pass", 1.0),
        makeSignal("test-pass", 1.0),
        makeSignal("test-pass", 1.0),
      ]
      assert.strictEqual(computeVerdict(signals), "pass")
    })

    it("returns fail when fail signals dominate", () => {
      const signals = [
        makeSignal("test-fail", 1.0),
        makeSignal("test-fail", 1.0),
        makeSignal("test-fail", 1.0),
      ]
      assert.strictEqual(computeVerdict(signals), "fail")
    })

    it("returns partial for mixed signals", () => {
      const signals = [makeSignal("test-pass", 1.0), makeSignal("test-fail", 1.0)]
      assert.strictEqual(computeVerdict(signals), "partial")
    })

    it("returns partial for empty signals", () => {
      assert.strictEqual(computeVerdict([]), "partial")
    })

    it("respects custom weights", () => {
      const signals = [makeSignal("test-pass", 1.0), makeSignal("test-fail", 1.0)]
      const weights = [10, 1]
      assert.strictEqual(computeVerdict(signals, weights), "pass")
    })
  })

  describe("matchSignalPattern", () => {
    it("matches by type and confidence", () => {
      const signal = makeSignal("test-fail", 0.9)
      const pattern: SignalPattern = { types: ["test-fail"], minConfidence: 0.5 }
      assert.strictEqual(matchSignalPattern(signal, pattern), true)
    })

    it("rejects when confidence is too low", () => {
      const signal = makeSignal("test-fail", 0.3)
      const pattern: SignalPattern = { types: ["test-fail"], minConfidence: 0.5 }
      assert.strictEqual(matchSignalPattern(signal, pattern), false)
    })

    it("rejects when type does not match", () => {
      const signal = makeSignal("compile-error", 0.9)
      const pattern: SignalPattern = { types: ["test-fail"], minConfidence: 0.5 }
      assert.strictEqual(matchSignalPattern(signal, pattern), false)
    })

    it("matches lang scope", () => {
      const signal = makeSignal("test-fail", 0.9)
      const pattern: SignalPattern = { types: ["test-fail"], minConfidence: 0.5, scope: "lang:typescript" }
      assert.strictEqual(matchSignalPattern(signal, pattern), true)
    })

    it("rejects lang scope mismatch", () => {
      const signal = makeSignal("test-fail", 0.9)
      const pattern: SignalPattern = { types: ["test-fail"], minConfidence: 0.5, scope: "lang:python" }
      assert.strictEqual(matchSignalPattern(signal, pattern), false)
    })

    it("matches context keyword", () => {
      const signal = {
        ...makeSignal("test-fail", 0.9),
        metadata: { userMessage: "Type error in auth service" },
      }
      const pattern: SignalPattern = { types: ["test-fail"], minConfidence: 0.5, matchContext: "auth" }
      assert.strictEqual(matchSignalPattern(signal, pattern), true)
    })

    it("rejects when context keyword is missing", () => {
      const signal = {
        ...makeSignal("test-fail", 0.9),
        metadata: { userMessage: "something else" },
      }
      const pattern: SignalPattern = { types: ["test-fail"], minConfidence: 0.5, matchContext: "auth" }
      assert.strictEqual(matchSignalPattern(signal, pattern), false)
    })

    it("matches repo path scope", () => {
      const signal = {
        ...makeSignal("test-fail", 0.9),
        metadata: { filePath: "src/auth/login.ts" },
      }
      const pattern: SignalPattern = { types: ["test-fail"], minConfidence: 0.5, scope: "auth" }
      assert.strictEqual(matchSignalPattern(signal, pattern), true)
    })

    it("rejects repo path scope mismatch", () => {
      const signal = {
        ...makeSignal("test-fail", 0.9),
        metadata: { filePath: "src/payment/checkout.ts" },
      }
      const pattern: SignalPattern = { types: ["test-fail"], minConfidence: 0.5, scope: "auth" }
      assert.strictEqual(matchSignalPattern(signal, pattern), false)
    })

    it("rejects repo path scope when no file path exists", () => {
      const signal = {
        ...makeSignal("test-fail", 0.9),
        metadata: {},
      }
      const pattern: SignalPattern = { types: ["test-fail"], minConfidence: 0.5, scope: "auth" }
      assert.strictEqual(matchSignalPattern(signal, pattern), false)
    })
  })

  describe("collector signalMatchesPattern", () => {
    it("matches type and context", () => {
      const signal = {
        ...makeSignal("test-fail", 0.9),
        metadata: { userMessage: "auth failure" },
      }
      const pattern: SignalPattern = { types: ["test-fail"], minConfidence: 0.5, matchContext: "auth" }
      assert.strictEqual(signalMatchesPattern(signal, pattern), true)
    })
  })
})
