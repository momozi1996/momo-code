/**
 * Heartbeat runner — one pass of periodic maintenance.
 *
 * A heartbeat:
 *   1. Runs every due schedule entry as a subagent (reuses the RLM spawn)
 *   2. Reports active persistent goals that need attention
 *   3. Optionally triggers the experience fast loop (MOMO_XP_AUTO=1)
 *
 * Invoked by `momo /heartbeat` (one shot) or `momo /daemon` (loop).
 *
 * @module schedule/runner
 */

import { Effect } from "effect"
import { spawnSubagent } from "../subagent/spawn.js"
import { dueEntries, markRan, type ScheduleEntry } from "./store.js"
import { loadGoals } from "../goal/store.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HeartbeatTaskResult {
  readonly entry: ScheduleEntry
  readonly exitCode: number
  readonly durationMs: number
  readonly timedOut: boolean
  readonly output: string
}

export interface HeartbeatResult {
  readonly startedAt: string
  readonly tasksRun: HeartbeatTaskResult[]
  /** Titles of active goals (reminder for the operator/agent) */
  readonly activeGoals: string[]
  readonly evolveTriggered: boolean
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Run one heartbeat pass. Never throws. */
export async function runHeartbeat(): Promise<HeartbeatResult> {
  const tasksRun: HeartbeatTaskResult[] = []

  // 1. Due scheduled tasks
  for (const entry of dueEntries()) {
    const result = await spawnSubagent(entry.prompt)
    tasksRun.push({
      entry,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      output: result.output,
    })
    markRan(entry.id)
  }

  // 2. Active goals reminder
  const activeGoals = loadGoals()
    .filter((g) => g.status === "active")
    .map((g) => g.title)

  // 3. Optional experience fast-loop trigger (opt-in via MOMO_XP_AUTO=1)
  let evolveTriggered = false
  if (process.env.MOMO_XP_AUTO === "1" || process.env.MOMO_XP_AUTO === "true") {
    try {
      const {
        Evolve,
        CollectorLive,
        DistillerLive,
        GateLive,
        BridgeLive,
        ExperienceStoreLive,
        ExperienceGuardLive,
      } = await import("../experience/index.js")
      await Effect.runPromise(
        Evolve({
          sessionId: `hb_${Date.now()}`,
          signals: [],
          mode: "balanced",
        }).pipe(
          Effect.provide(ExperienceStoreLive),
          Effect.provide(DistillerLive),
          Effect.provide(CollectorLive),
          Effect.provide(GateLive),
          Effect.provide(BridgeLive),
          Effect.provide(ExperienceGuardLive),
          Effect.catchAll(() => Effect.void),
        ),
      )
      evolveTriggered = true
    } catch {
      // evolution is best-effort during heartbeat
    }
  }

  return {
    startedAt: new Date().toISOString(),
    tasksRun,
    activeGoals,
    evolveTriggered,
  }
}
