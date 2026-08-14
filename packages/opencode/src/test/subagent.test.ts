import { describe, it, afterEach } from "node:test"
import assert from "node:assert"
import {
  canSpawn,
  currentDepth,
  maxDepth,
  selfCommand,
  spawnSubagent,
} from "../subagent/spawn"

describe("subagent/spawn", () => {
  const touched = ["MOMO_RLM_DEPTH", "MOMO_RLM_MAX_DEPTH"]

  afterEach(() => {
    for (const k of touched) delete process.env[k]
  })

  it("currentDepth/maxDepth read env with defaults", () => {
    assert.strictEqual(currentDepth(), 0)
    assert.strictEqual(maxDepth(), 3)
    process.env.MOMO_RLM_DEPTH = "2"
    process.env.MOMO_RLM_MAX_DEPTH = "5"
    assert.strictEqual(currentDepth(), 2)
    assert.strictEqual(maxDepth(), 5)
  })

  it("canSpawn respects the depth limit", () => {
    assert.ok(canSpawn())
    process.env.MOMO_RLM_DEPTH = "3"
    assert.ok(!canSpawn())
    process.env.MOMO_RLM_DEPTH = "99"
    assert.ok(!canSpawn())
  })

  it("selfCommand returns an executable command", () => {
    const { cmd, baseArgs } = selfCommand()
    assert.ok(cmd.length > 0)
    // when running under tsx/node with a .ts/.js entry, the script is included
    if (baseArgs.length > 0) {
      assert.ok(/\.(js|mjs|cjs|ts)$/.test(baseArgs[0]))
    }
  })

  it("refuses to spawn beyond the depth limit without spawning a process", async () => {
    process.env.MOMO_RLM_DEPTH = "3"
    const result = await spawnSubagent("anything")
    assert.strictEqual(result.exitCode, 1)
    assert.ok(result.output.includes("depth limit"))
    assert.strictEqual(result.depth, 4)
    assert.strictEqual(result.timedOut, false)
  })
})
