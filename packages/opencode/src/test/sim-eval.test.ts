import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  computeMetrics,
  getEvalsDir,
  saveReport,
  type EpisodeResult,
} from "../sim/eval"

function ep(success: boolean, steps: number, durationMs: number): EpisodeResult {
  return {
    task: "t",
    episode: 1,
    success,
    steps,
    durationMs,
    summary: success ? "ok" : "",
  }
}

describe("sim/eval metrics", () => {
  it("computes success rate, avg steps, avg duration", () => {
    const m = computeMetrics([ep(true, 5, 1000), ep(true, 7, 3000), ep(false, 12, 2000)])
    assert.strictEqual(m.episodes, 3)
    assert.strictEqual(m.successes, 2)
    assert.strictEqual(m.successRate, 0.667)
    assert.strictEqual(m.avgSteps, 8)
    assert.strictEqual(m.avgDurationMs, 2000)
  })

  it("handles all-fail and all-pass", () => {
    assert.strictEqual(computeMetrics([ep(false, 1, 1)]).successRate, 0)
    assert.strictEqual(computeMetrics([ep(true, 1, 1)]).successRate, 1)
  })

  it("handles empty results", () => {
    const m = computeMetrics([])
    assert.strictEqual(m.episodes, 0)
    assert.strictEqual(m.successRate, 0)
  })
})

describe("sim/eval report persistence", () => {
  let saved: string | undefined
  let tmp: string

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momo-eval-"))
    saved = process.env.MOMO_CONFIG_DIR
    process.env.MOMO_CONFIG_DIR = tmp
  })

  after(() => {
    if (saved === undefined) delete process.env.MOMO_CONFIG_DIR
    else process.env.MOMO_CONFIG_DIR = saved
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("saves reports under ~/.momo/sim/evals", () => {
    const file = saveReport({
      startedAt: "2026-08-08T10:00:00.000Z",
      tasks: 1,
      episodesPerTask: 1,
      results: [ep(true, 3, 100)],
      metrics: computeMetrics([ep(true, 3, 100)]),
    })
    assert.ok(file.startsWith(getEvalsDir()))
    assert.ok(fs.existsSync(file))
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"))
    assert.strictEqual(parsed.metrics.successRate, 1)
  })
})
