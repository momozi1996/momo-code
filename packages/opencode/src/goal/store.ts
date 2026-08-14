/**
 * Persistent goals — Prime Agent-style /goal tracking.
 *
 * Goals live in `~/.momo/goals.json` and survive across sessions.
 * Active goals are injected into the system prompt of every chat run
 * (see chat.ts), so the agent keeps long-term objectives in view.
 *
 * @module goal/store
 */

import * as fs from "fs"
import * as path from "path"
import * as crypto from "crypto"
import { getMomoHome } from "../session/recorder.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GoalLogEntry {
  readonly ts: string
  readonly note: string
}

export interface Goal {
  /** Unique id: `goal_<hash>` */
  readonly id: string
  readonly title: string
  readonly detail?: string
  status: "active" | "done"
  log: GoalLogEntry[]
  readonly createdAt: string
  updatedAt: string
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getGoalsPath(): string {
  return path.join(getMomoHome(), "goals.json")
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function loadGoals(): Goal[] {
  try {
    const file = getGoalsPath()
    if (!fs.existsSync(file)) return []
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      goals?: Goal[]
    }
    return data.goals ?? []
  } catch {
    return []
  }
}

export function saveGoals(goals: Goal[]): void {
  const file = getGoalsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify({ goals }, null, 2), "utf-8")
  fs.renameSync(tmp, file)
}

export function addGoal(title: string, detail?: string): Goal {
  const now = new Date().toISOString()
  const goal: Goal = {
    id: `goal_${crypto.createHash("sha256").update(`${title}:${now}`).digest("hex").slice(0, 8)}`,
    title,
    ...(detail ? { detail } : {}),
    status: "active",
    log: [{ ts: now, note: "goal created" }],
    createdAt: now,
    updatedAt: now,
  }
  saveGoals([...loadGoals(), goal])
  return goal
}

/** Find a goal by full id or unique id prefix. */
export function findGoal(idOrPrefix: string): Goal | null {
  const goals = loadGoals()
  const exact = goals.find((g) => g.id === idOrPrefix)
  if (exact) return exact
  const matches = goals.filter((g) => g.id.startsWith(idOrPrefix))
  return matches.length === 1 ? matches[0] : null
}

export function updateGoal(idOrPrefix: string, fn: (g: Goal) => void): Goal | null {
  const goals = loadGoals()
  const target = findGoal(idOrPrefix)
  if (!target) return null
  const idx = goals.findIndex((g) => g.id === target.id)
  fn(goals[idx])
  goals[idx].updatedAt = new Date().toISOString()
  saveGoals(goals)
  return goals[idx]
}

export function removeGoal(idOrPrefix: string): boolean {
  const target = findGoal(idOrPrefix)
  if (!target) return false
  saveGoals(loadGoals().filter((g) => g.id !== target.id))
  return true
}

// ---------------------------------------------------------------------------
// Prompt injection
// ---------------------------------------------------------------------------

/** Max characters of the injected goals block (~512 tokens). */
const GOALS_BLOCK_BUDGET = 2048

/**
 * Format active goals as a markdown block for system-prompt injection.
 * Most recently updated goals first; truncated to the token budget.
 */
export function activeGoalsBlock(): string {
  const active = loadGoals()
    .filter((g) => g.status === "active")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  if (active.length === 0) return ""

  let out = "## Persistent Goals\n\nYou have long-term goals that span sessions. Work toward them when relevant:\n"
  for (const g of active) {
    const lastLog = g.log.length > 0 ? g.log[g.log.length - 1].note : ""
    const entry = `\n- **${g.title}** (${g.id}, since ${g.createdAt.slice(0, 10)})${lastLog ? ` — latest: ${lastLog}` : ""}`
    if (out.length + entry.length > GOALS_BLOCK_BUDGET) break
    out += entry
  }
  return out
}
