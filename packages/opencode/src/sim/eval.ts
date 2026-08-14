/**
 * Sim eval harness — batch evaluation of the /sim control loop.
 *
 * Runs a task list for N episodes each (fresh world per episode) and
 * reports the core metrics: success rate, average steps, average
 * wall time. Results are persisted to ~/.momo/sim/evals/<ts>.json.
 *
 * @module sim/eval
 */

import * as fs from "fs"
import * as path from "path"
import { getMomoHome } from "../session/recorder.js"
import { SimBridge } from "./bridge.js"
import { runSimLoop } from "./loop.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EvalTask {
  readonly task: string
  readonly max_steps?: number
}

export interface EpisodeResult {
  readonly task: string
  readonly episode: number
  readonly success: boolean
  readonly steps: number
  readonly durationMs: number
  readonly summary: string
  readonly error?: string
}

export interface EvalMetrics {
  readonly episodes: number
  readonly successes: number
  readonly successRate: number
  readonly avgSteps: number
  readonly avgDurationMs: number
}

export interface EvalReport {
  readonly startedAt: string
  readonly tasks: number
  readonly episodesPerTask: number
  readonly results: EpisodeResult[]
  readonly metrics: EvalMetrics
}

// ---------------------------------------------------------------------------
// Metrics (pure — unit-tested)
// ---------------------------------------------------------------------------

export function computeMetrics(results: EpisodeResult[]): EvalMetrics {
  if (results.length === 0) {
    return { episodes: 0, successes: 0, successRate: 0, avgSteps: 0, avgDurationMs: 0 }
  }
  const successes = results.filter((r) => r.success).length
  const avgSteps = results.reduce((s, r) => s + r.steps, 0) / results.length
  const avgDurationMs = results.reduce((s, r) => s + r.durationMs, 0) / results.length
  return {
    episodes: results.length,
    successes,
    successRate: Math.round((successes / results.length) * 1000) / 1000,
    avgSteps: Math.round(avgSteps * 10) / 10,
    avgDurationMs: Math.round(avgDurationMs),
  }
}

export function getEvalsDir(): string {
  return path.join(getMomoHome(), "sim", "evals")
}

export function saveReport(report: EvalReport): string {
  const dir = getEvalsDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${report.startedAt.replace(/[:.]/g, "-")}.json`)
  fs.writeFileSync(file, JSON.stringify(report, null, 2), "utf-8")
  return file
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run the evaluation. Each episode gets a fresh SimBridge (fresh world).
 * `onEpisode` is called after every episode (for live progress output).
 */
export async function runEval(
  tasks: EvalTask[],
  episodes: number,
  onEpisode?: (r: EpisodeResult) => void,
): Promise<EvalReport> {
  const results: EpisodeResult[] = []

  for (const t of tasks) {
    for (let ep = 1; ep <= episodes; ep++) {
      const bridge = new SimBridge()
      const startMs = Date.now()
      let result: EpisodeResult
      try {
        const loop = await runSimLoop(t.task, bridge, {
          ...(t.max_steps ? { maxSteps: t.max_steps } : {}),
        })
        result = {
          task: t.task,
          episode: ep,
          success: loop.done,
          steps: loop.turns.filter((x) => x.code).length,
          durationMs: Date.now() - startMs,
          summary: loop.summary,
          ...(loop.error ? { error: loop.error } : {}),
        }
      } catch (err) {
        result = {
          task: t.task,
          episode: ep,
          success: false,
          steps: 0,
          durationMs: Date.now() - startMs,
          summary: "",
          error: err instanceof Error ? err.message : String(err),
        }
      } finally {
        await bridge.close()
      }
      results.push(result)
      onEpisode?.(result)
    }
  }

  return {
    startedAt: new Date().toISOString(),
    tasks: tasks.length,
    episodesPerTask: episodes,
    results,
    metrics: computeMetrics(results),
  }
}
