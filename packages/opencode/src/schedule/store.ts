/**
 * Schedule store — timed task definitions for /heartbeat and /daemon.
 *
 * Entries live in `~/.momo/schedule.json`:
 *   { id, prompt, intervalMin?, dailyAt?, enabled, lastRunAt? }
 *
 * Either `intervalMin` (run every N minutes) or `dailyAt` ("HH:MM",
 * local time, once per day) must be set.
 *
 * @module schedule/store
 */

import * as fs from "fs"
import * as path from "path"
import * as crypto from "crypto"
import { getMomoHome } from "../session/recorder.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduleEntry {
  /** Unique id: `sch_<hash>` */
  readonly id: string
  /** The prompt to run when due */
  readonly prompt: string
  /** Run every N minutes */
  readonly intervalMin?: number
  /** Run once per day at "HH:MM" local time */
  readonly dailyAt?: string
  enabled: boolean
  /** ISO-8601 timestamp of the last run */
  lastRunAt?: string
  readonly createdAt: string
}

// ---------------------------------------------------------------------------
// Paths & CRUD
// ---------------------------------------------------------------------------

export function getSchedulePath(): string {
  return path.join(getMomoHome(), "schedule.json")
}

export function loadSchedule(): ScheduleEntry[] {
  try {
    const file = getSchedulePath()
    if (!fs.existsSync(file)) return []
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      entries?: ScheduleEntry[]
    }
    return data.entries ?? []
  } catch {
    return []
  }
}

export function saveSchedule(entries: ScheduleEntry[]): void {
  const file = getSchedulePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2), "utf-8")
  fs.renameSync(tmp, file)
}

export function addScheduleEntry(
  prompt: string,
  opts: { intervalMin?: number; dailyAt?: string },
): ScheduleEntry {
  const entry: ScheduleEntry = {
    id: `sch_${crypto.createHash("sha256").update(`${prompt}:${Date.now()}`).digest("hex").slice(0, 8)}`,
    prompt,
    ...(opts.intervalMin ? { intervalMin: opts.intervalMin } : {}),
    ...(opts.dailyAt ? { dailyAt: opts.dailyAt } : {}),
    enabled: true,
    createdAt: new Date().toISOString(),
  }
  saveSchedule([...loadSchedule(), entry])
  return entry
}

export function removeScheduleEntry(idOrPrefix: string): boolean {
  const entries = loadSchedule()
  const target = entries.find(
    (e) => e.id === idOrPrefix || (e.id.startsWith(idOrPrefix) && entries.filter((x) => x.id.startsWith(idOrPrefix)).length === 1),
  )
  if (!target) return false
  saveSchedule(entries.filter((e) => e.id !== target.id))
  return true
}

export function markRan(id: string): void {
  const entries = loadSchedule()
  const idx = entries.findIndex((e) => e.id === id)
  if (idx === -1) return
  entries[idx].lastRunAt = new Date().toISOString()
  saveSchedule(entries)
}

// ---------------------------------------------------------------------------
// Due calculation
// ---------------------------------------------------------------------------

/** Is this entry due to run right now? */
export function isDue(entry: ScheduleEntry, now: Date = new Date()): boolean {
  if (!entry.enabled) return false
  const last = entry.lastRunAt ? new Date(entry.lastRunAt).getTime() : 0
  const nowMs = now.getTime()

  if (entry.intervalMin) {
    return nowMs - last >= entry.intervalMin * 60_000
  }
  if (entry.dailyAt) {
    const [hh, mm] = entry.dailyAt.split(":").map(Number)
    if (Number.isNaN(hh) || Number.isNaN(mm)) return false
    const today = new Date(now)
    today.setHours(hh, mm, 0, 0)
    // Due when we've passed today's time and haven't run since then
    return nowMs >= today.getTime() && last < today.getTime()
  }
  return false
}

/** All enabled entries that are due right now. */
export function dueEntries(now: Date = new Date()): ScheduleEntry[] {
  return loadSchedule().filter((e) => isDue(e, now))
}
