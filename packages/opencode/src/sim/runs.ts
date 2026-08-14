/**
 * Sim run store — persisted records of /sim runs started from the UI.
 *
 * A run is the full transcript of one `runSimLoop` invocation: task,
 * status, and every agent turn (thought / code / stdout / error). Runs
 * live in `~/.momo/sim/runs/<id>.json` and are written atomically after
 * every turn, so the dashboard can stream progress live.
 *
 * @module sim/runs
 */

import * as fs from "fs"
import * as path from "path"
import * as crypto from "crypto"
import { getMomoHome } from "../session/recorder.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SimRunTurn {
  readonly step: number
  readonly thought?: string
  readonly code?: string
  readonly stdout?: string
  readonly stderr?: string
  readonly error?: string
}

export interface SimRun {
  readonly id: string
  readonly task: string
  status: "running" | "done" | "failed"
  readonly createdAt: string
  updatedAt: string
  readonly turns: SimRunTurn[]
  summary?: string
  error?: string
}

export interface SimRunSummary {
  readonly id: string
  readonly task: string
  status: "running" | "done" | "failed"
  readonly createdAt: string
  readonly updatedAt: string
  readonly turnCount: number
  readonly hasError: boolean
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function getSimRunsDir(): string {
  return path.join(getMomoHome(), "sim", "runs")
}

function runPath(id: string): string {
  return path.join(getSimRunsDir(), `${id}.json`)
}

export function newSimRunId(): string {
  return `sr_${crypto.createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 12)}`
}

function writeRun(run: SimRun): void {
  fs.mkdirSync(getSimRunsDir(), { recursive: true })
  const file = runPath(run.id)
  const tmp = `${file}.tmp.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2), "utf-8")
  fs.renameSync(tmp, file)
}

/** Create a run record and persist it (call before launching the loop). */
export function createSimRun(task: string): SimRun {
  const now = new Date().toISOString()
  const run: SimRun = {
    id: newSimRunId(),
    task,
    status: "running",
    createdAt: now,
    updatedAt: now,
    turns: [],
  }
  writeRun(run)
  return run
}

export function appendSimTurn(run: SimRun, turn: SimRunTurn): void {
  run.turns.push(turn)
  run.updatedAt = new Date().toISOString()
  writeRun(run)
}

export function finishSimRun(
  run: SimRun,
  result: { done: boolean; summary: string; error?: string },
): void {
  run.status = result.done ? "done" : result.error ? "failed" : "failed"
  if (result.summary) run.summary = result.summary
  if (result.error) run.error = result.error
  run.updatedAt = new Date().toISOString()
  writeRun(run)
}

export function loadSimRun(id: string): SimRun | null {
  try {
    const file = runPath(id)
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, "utf-8")) as SimRun
  } catch {
    return null
  }
}

export function listSimRuns(limit = 20): SimRunSummary[] {
  const dir = getSimRunsDir()
  try {
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as SimRun
          return {
            id: r.id,
            task: r.task,
            status: r.status,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            turnCount: r.turns.length,
            hasError: !!r.error,
          }
        } catch {
          return null
        }
      })
      .filter((x): x is SimRunSummary => x !== null)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
  } catch {
    return []
  }
}