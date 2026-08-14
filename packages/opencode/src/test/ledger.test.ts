import { describe, it } from "node:test"
import assert from "node:assert"
import {
  formatLedgerEntry,
  parseLedgerEntry,
  type LedgerEntry,
} from "../experience/ledger"

describe("ledger", () => {
  const ts = "2026-06-28T10:00:00.000Z"

  describe("formatLedgerEntry", () => {
    it("formats observe entries", () => {
      const entry: LedgerEntry = {
        kind: "observe",
        sessionId: "sess-1",
        signalCount: 3,
        timestamp: ts,
      }
      const json = formatLedgerEntry(entry)
      assert.ok(json.startsWith('{"kind":"observe","timestamp":"'))
      assert.ok(json.includes('"sessionId":"sess-1"'))
      assert.ok(json.includes('"signalCount":3'))
    })

    it("formats distill entries", () => {
      const entry: LedgerEntry = {
        kind: "distill",
        tacticIds: ["tac-1", "tac-2"],
        summary: "extracted 2 tactics",
        timestamp: ts,
      }
      const json = formatLedgerEntry(entry)
      assert.ok(json.includes('"tacticIds":["tac-1","tac-2"]'))
      assert.ok(json.includes('"summary":"extracted 2 tactics"'))
    })

    it("formats inject entries", () => {
      const entry: LedgerEntry = {
        kind: "inject",
        sessionId: "sess-1",
        tacticIds: ["tac-1"],
        timestamp: ts,
      }
      const json = formatLedgerEntry(entry)
      assert.ok(json.includes('"sessionId":"sess-1"'))
      assert.ok(json.includes('"tacticIds":["tac-1"]'))
    })

    it("formats solidify entries", () => {
      const entry: LedgerEntry = {
        kind: "solidify",
        caseId: "case-1",
        tacticId: "tac-1",
        verdict: "pass",
        timestamp: ts,
      }
      const json = formatLedgerEntry(entry)
      assert.ok(json.includes('"caseId":"case-1"'))
      assert.ok(json.includes('"verdict":"pass"'))
    })

    it("formats promote entries", () => {
      const entry: LedgerEntry = {
        kind: "promote",
        tacticId: "tac-1",
        from: "draft",
        to: "active",
        timestamp: ts,
      }
      const json = formatLedgerEntry(entry)
      assert.ok(json.includes('"from":"draft"'))
      assert.ok(json.includes('"to":"active"'))
    })

    it("formats retire entries", () => {
      const entry: LedgerEntry = {
        kind: "retire",
        tacticId: "tac-1",
        reason: "poor performance",
        timestamp: ts,
      }
      const json = formatLedgerEntry(entry)
      assert.ok(json.includes('"reason":"poor performance"'))
    })

    it("formats bridge entries", () => {
      const entry: LedgerEntry = {
        kind: "bridge",
        caseIds: ["case-1", "case-2"],
        target: "curriculum",
        timestamp: ts,
      }
      const json = formatLedgerEntry(entry)
      assert.ok(json.includes('"caseIds":["case-1","case-2"]'))
      assert.ok(json.includes('"target":"curriculum"'))
    })
  })

  describe("parseLedgerEntry", () => {
    it("parses a formatted observe entry", () => {
      const entry: LedgerEntry = {
        kind: "observe",
        sessionId: "sess-1",
        signalCount: 3,
        timestamp: ts,
      }
      const parsed = parseLedgerEntry(formatLedgerEntry(entry))
      assert.deepStrictEqual(parsed, entry)
    })

    it("parses a formatted bridge entry", () => {
      const entry: LedgerEntry = {
        kind: "bridge",
        caseIds: ["case-1"],
        target: "curriculum",
        timestamp: ts,
      }
      const parsed = parseLedgerEntry(formatLedgerEntry(entry))
      assert.deepStrictEqual(parsed, entry)
    })

    it("returns null for empty lines", () => {
      assert.strictEqual(parseLedgerEntry(""), null)
      assert.strictEqual(parseLedgerEntry("   "), null)
      assert.strictEqual(parseLedgerEntry("\n"), null)
    })

    it("returns null for invalid JSON", () => {
      assert.strictEqual(parseLedgerEntry("not json"), null)
    })

    it("returns null when kind is missing", () => {
      assert.strictEqual(parseLedgerEntry('{"timestamp":"2026-01-01T00:00:00.000Z"}'), null)
    })

    it("returns null when timestamp is missing", () => {
      assert.strictEqual(parseLedgerEntry('{"kind":"observe"}'), null)
    })

    it("returns null for unknown kinds", () => {
      assert.strictEqual(
        parseLedgerEntry('{"kind":"unknown","timestamp":"2026-01-01T00:00:00.000Z"}'),
        null,
      )
    })

    it("returns null when observe entry lacks signalCount", () => {
      const bad = '{"kind":"observe","timestamp":"2026-01-01T00:00:00.000Z","sessionId":"s1"}'
      assert.strictEqual(parseLedgerEntry(bad), null)
    })

    it("returns null when distill entry lacks tacticIds", () => {
      const bad = '{"kind":"distill","timestamp":"2026-01-01T00:00:00.000Z","summary":"x"}'
      assert.strictEqual(parseLedgerEntry(bad), null)
    })

    it("returns null when inject entry lacks sessionId", () => {
      const bad = '{"kind":"inject","timestamp":"2026-01-01T00:00:00.000Z","tacticIds":[]}'
      assert.strictEqual(parseLedgerEntry(bad), null)
    })

    it("returns null when solidify entry lacks required fields", () => {
      const bad = '{"kind":"solidify","timestamp":"2026-01-01T00:00:00.000Z","caseId":"c1"}'
      assert.strictEqual(parseLedgerEntry(bad), null)
    })

    it("returns null when promote entry lacks required fields", () => {
      const bad = '{"kind":"promote","timestamp":"2026-01-01T00:00:00.000Z","tacticId":"t1"}'
      assert.strictEqual(parseLedgerEntry(bad), null)
    })

    it("returns null when retire entry lacks reason", () => {
      const bad = '{"kind":"retire","timestamp":"2026-01-01T00:00:00.000Z","tacticId":"t1"}'
      assert.strictEqual(parseLedgerEntry(bad), null)
    })

    it("returns null when bridge target is not curriculum", () => {
      const bad = '{"kind":"bridge","timestamp":"2026-01-01T00:00:00.000Z","caseIds":[],"target":"other"}'
      assert.strictEqual(parseLedgerEntry(bad), null)
    })
  })
})
