/**
 * Optim study store — persistence for /optim reasoning-driven optimization.
 *
 * A study is a directory under `~/.momo/optim/studies/<name>/`:
 *
 *   study.json    — frozen config (direction, search space, metric, evaluator)
 *   trials.jsonl  — append-only trial history (params, value, _reasoning, _note)
 *
 * Discipline (borrowed from optim-agent):
 *   - The search space is frozen at init; re-declaring a parameter with
 *     different bounds/type raises loudly (a changed distribution would
 *     invalidate the history the agent reasons over).
 *   - Resuming with a different direction raises instead of silently
 *     optimizing the wrong way.
 *   - All writes are atomic (tmp + rename); a crash mid-write cannot
 *     corrupt the study.
 *
 * @module optim/study
 */

import * as fs from "fs"
import * as path from "path"
import { getMomoHome } from "../session/recorder.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Direction = "minimize" | "maximize"
export type ParamType = "float" | "int" | "categorical"
export type ParamValue = number | string

export interface ParamSpec {
  readonly name: string
  readonly type: ParamType
  /** float/int only */
  readonly low?: number
  readonly high?: number
  /** log-scale sampling (requires low > 0) */
  readonly log?: boolean
  /** categorical only */
  readonly choices?: string[]
}

export type TrialState = "complete" | "failed" | "pruned"

export interface TrialRecord {
  readonly number: number
  readonly params: Record<string, ParamValue>
  readonly state: TrialState
  readonly ts: string
  readonly value?: number
  readonly durationMs?: number
  /** Agent's explicit justification for this proposal (reasoning-driven core) */
  readonly reasoning?: string
  /** Agent's qualitative note about the landscape — fed back next trial */
  readonly note?: string
  /** true when the point came from random fallback instead of the agent */
  readonly fallback?: boolean
  readonly error?: string
}

export type EvaluatorSpec =
  | { readonly kind: "cmd"; readonly cmd: string }
  | { readonly kind: "sim"; readonly task: string }

export interface StudyConfig {
  readonly name: string
  readonly direction: Direction
  readonly space: readonly ParamSpec[]
  /** Metric key parsed from evaluator output (default "metric") */
  readonly metric: string
  /** Free-text: what is being tuned — highest-leverage prompt knob */
  readonly context?: string
  readonly evaluator: EvaluatorSpec
  readonly createdAt: string
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getStudiesDir(): string {
  return path.join(getMomoHome(), "optim", "studies")
}

export function getStudyDir(name: string): string {
  return path.join(getStudiesDir(), name)
}

function studyFile(name: string): string {
  return path.join(getStudyDir(name), "study.json")
}

function trialsFile(name: string): string {
  return path.join(getStudyDir(name), "trials.jsonl")
}

// ---------------------------------------------------------------------------
// Param spec parsing (CLI form) — pure, unit-tested
// ---------------------------------------------------------------------------

/**
 * Parse a `--param` spec:
 *   "lr:1e-5:1e-1:log"    → float, log scale
 *   "threshold:0.05:0.95" → float
 *   "budget:10:200:int"   → int
 *   "depth:2:8:int,log"   → int, log scale
 *   "model:a,b,c"         → categorical
 */
export function parseParamSpec(spec: string): ParamSpec {
  const parts = spec.split(":")
  const name = parts[0]?.trim()
  if (!name) throw new Error(`Invalid --param spec: "${spec}" (missing name)`)

  // categorical: name:a,b,c
  if (parts.length === 2) {
    const choices = parts[1].split(",").map((s) => s.trim()).filter(Boolean)
    if (choices.length < 2) {
      throw new Error(`Categorical param "${name}" needs ≥2 comma-separated choices`)
    }
    return { name, type: "categorical", choices }
  }

  if (parts.length < 3 || parts.length > 4) {
    throw new Error(
      `Invalid --param spec: "${spec}". Use name:low:high[:log|int|int,log] or name:a,b,c`,
    )
  }
  const low = Number(parts[1])
  const high = Number(parts[2])
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    throw new Error(`Invalid bounds in --param "${spec}"`)
  }
  if (low >= high) throw new Error(`Param "${name}": low must be < high`)

  const flags = (parts[3] || "").split(",").map((s) => s.trim()).filter(Boolean)
  const type: ParamType = flags.includes("int") ? "int" : "float"
  const log = flags.includes("log")
  for (const f of flags) {
    if (f !== "int" && f !== "log") {
      throw new Error(`Unknown flag "${f}" in --param "${spec}" (use int|log)`)
    }
  }
  if (log && low <= 0) {
    throw new Error(`Param "${name}": log scale requires low > 0`)
  }
  return { name, type, low, high, ...(log ? { log } : {}) }
}

// ---------------------------------------------------------------------------
// Space discipline
// ---------------------------------------------------------------------------

/**
 * Assert that a proposed parameter declaration is consistent with the frozen
 * space. Re-declaring with different bounds/type raises (loud, not silent).
 */
export function assertParamConsistent(space: readonly ParamSpec[], spec: ParamSpec): void {
  const existing = space.find((p) => p.name === spec.name)
  if (!existing) {
    throw new Error(`Unknown parameter "${spec.name}" — not in the study's frozen space`)
  }
  if (existing.type !== spec.type) {
    throw new Error(
      `Parameter "${spec.name}" was registered as ${existing.type}, not ${spec.type}. ` +
        `A changed distribution invalidates the history — start a new study.`,
    )
  }
  if (
    existing.type !== "categorical" &&
    (existing.low !== spec.low || existing.high !== spec.high || !!existing.log !== !!spec.log)
  ) {
    throw new Error(
      `Parameter "${spec.name}" bounds changed mid-study — start a new study instead.`,
    )
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Create a new study. Throws if one with the same name already exists. */
export function createStudy(config: Omit<StudyConfig, "createdAt">): StudyConfig {
  const dir = getStudyDir(config.name)
  if (fs.existsSync(studyFile(config.name))) {
    throw new Error(`Study "${config.name}" already exists at ${dir}`)
  }
  if (config.space.length === 0) {
    throw new Error(`Study "${config.name}" has an empty search space`)
  }
  const full: StudyConfig = { ...config, createdAt: new Date().toISOString() }
  fs.mkdirSync(dir, { recursive: true })
  atomicWrite(studyFile(config.name), JSON.stringify(full, null, 2))
  fs.writeFileSync(trialsFile(config.name), "", "utf-8")
  return full
}

/** Load a study config, or null if missing/corrupt. */
export function loadStudy(name: string): StudyConfig | null {
  try {
    const file = studyFile(name)
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, "utf-8")) as StudyConfig
  } catch {
    return null
  }
}

/** List all study names. */
export function listStudies(): string[] {
  try {
    const dir = getStudiesDir()
    if (!fs.existsSync(dir)) return []
    return fs
      .readdirSync(dir)
      .filter((f) => fs.existsSync(studyFile(f)))
      .sort()
  } catch {
    return []
  }
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp.${Date.now()}`
  fs.writeFileSync(tmp, content, "utf-8")
  fs.renameSync(tmp, file)
}

/** Append a trial record (JSONL). */
export function appendTrial(name: string, record: TrialRecord): void {
  const file = trialsFile(name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf-8")
}

/** Read the full trial history, in order. Skips corrupt lines. */
export function readTrials(name: string): TrialRecord[] {
  try {
    const file = trialsFile(name)
    if (!fs.existsSync(file)) return []
    const out: TrialRecord[] = []
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line) as TrialRecord)
      } catch {
        // skip corrupt line
      }
    }
    return out.sort((a, b) => a.number - b.number)
  } catch {
    return []
  }
}

export function nextTrialNumber(trials: readonly TrialRecord[]): number {
  return trials.length === 0 ? 0 : trials[trials.length - 1].number + 1
}

/** Best completed trial respecting the study direction, or null. */
export function bestTrial(
  direction: Direction,
  trials: readonly TrialRecord[],
): TrialRecord | null {
  const completed = trials.filter((t) => t.state === "complete" && t.value !== undefined)
  if (completed.length === 0) return null
  return completed.reduce((best, t) =>
    direction === "maximize"
      ? (t.value! > best.value! ? t : best)
      : (t.value! < best.value! ? t : best),
  )
}

/** The agent's most recent qualitative note (scratchpad fed forward). */
export function lastNote(trials: readonly TrialRecord[]): string | undefined {
  for (let i = trials.length - 1; i >= 0; i--) {
    if (trials[i].note) return trials[i].note
  }
  return undefined
}
