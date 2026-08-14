import { describe, it } from "node:test"
import assert from "node:assert"
import { Effect } from "effect"
import { Guard } from "../evolve/guard"

describe("guard", () => {
  describe("scrubSecrets", () => {
    it("redacts API keys from sample contexts", async () => {
      const samples = [
        { id: "1", context: "api_key=sk-abc12345678901234567890" },
        { id: "2", context: "Email me at user@example.com please" },
      ]

      const scrubbed = await Effect.runPromise(Guard.scrubSecrets(samples))

      assert.ok(scrubbed[0].context.includes("[REDACTED_SECRET]"))
      assert.ok(scrubbed[1].context.includes("[REDACTED_PII]"))
      assert.equal(scrubbed.scrubbed, true)
      assert.ok(scrubbed.secretMatches > 0)
      assert.ok(scrubbed.piiMatches > 0)
      assert.ok(scrubbed.details.length > 0)
    })

    it("leaves clean contexts unchanged", async () => {
      const samples = [{ id: "1", context: "const x = 1" }]

      const scrubbed = await Effect.runPromise(Guard.scrubSecrets(samples))

      assert.equal(scrubbed[0].context, "const x = 1")
      assert.equal(scrubbed.scrubbed, false)
      assert.equal(scrubbed.secretMatches, 0)
      assert.equal(scrubbed.piiMatches, 0)
    })
  })

  describe("containsSecrets", () => {
    it("detects secrets in text", async () => {
      const hasSecret = await Effect.runPromise(
        Guard.containsSecrets("Authorization: Bearer abcdef123"),
      )
      assert.equal(hasSecret, true)
    })

    it("returns false for clean text", async () => {
      const hasSecret = await Effect.runPromise(
        Guard.containsSecrets("console.log('hello')"),
      )
      assert.equal(hasSecret, false)
    })
  })

  describe("validateDataset", () => {
    it("reports issues for unsafe samples", async () => {
      const samples = [{ id: "1", context: "password=supersecret" }]
      const result = await Effect.runPromise(Guard.validateDataset(samples))

      assert.equal(result.passed, false)
      assert.ok(result.issues.length > 0)
    })

    it("passes clean datasets", async () => {
      const samples = [{ id: "1", context: "function add(a, b) { return a + b }" }]
      const result = await Effect.runPromise(Guard.validateDataset(samples))

      assert.equal(result.passed, true)
      assert.equal(result.issues.length, 0)
    })
  })
})
