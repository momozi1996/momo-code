import { describe, it } from "node:test"
import assert from "node:assert"
import { parseSimAction } from "../sim/loop"

describe("sim/loop action parsing", () => {
  it("parses a code action", () => {
    const action = parseSimAction(
      '{"thought": "add a plane", "code": "scene.add_entity(gs.morphs.Plane())"}',
    )
    assert.ok(action)
    assert.strictEqual(action.done, false)
    assert.strictEqual(action.thought, "add a plane")
    assert.ok(action.code!.includes("Plane"))
  })

  it("parses a done action", () => {
    const action = parseSimAction('{"done": true, "summary": "cube moved"}')
    assert.ok(action)
    assert.strictEqual(action.done, true)
    assert.strictEqual(action.summary, "cube moved")
  })

  it("tolerates prose around the JSON", () => {
    const action = parseSimAction(
      'Sure! Here you go:\n```json\n{"thought": "t", "code": "print(1)"}\n```\nDone.',
    )
    assert.ok(action)
    assert.strictEqual(action.done, false)
  })

  it("rejects empty code", () => {
    assert.strictEqual(parseSimAction('{"thought": "x", "code": "  "}'), null)
  })

  it("rejects non-JSON replies", () => {
    assert.strictEqual(parseSimAction("I think you should add a plane"), null)
  })

  it("handles done without summary", () => {
    const action = parseSimAction('{"done": true}')
    assert.ok(action?.done)
    assert.strictEqual(action?.summary, "(no summary)")
  })
})
