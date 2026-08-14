/**
 * /heartbeat command — run one pass of periodic maintenance.
 *
 *   momo /heartbeat [--json]
 *
 * Executes all due scheduled tasks, reports active goals, and
 * (when MOMO_XP_AUTO=1) triggers one experience fast-loop cycle.
 */
import { runHeartbeat } from "../../schedule/runner.js"

const GREEN = "\x1b[32m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const MAGENTA = "\x1b[95m"

export async function runHeartbeatCommand(args: string[]): Promise<void> {
  const json = args.includes("--json")

  console.error(`${DIM}→ heartbeat ${new Date().toISOString()}${RESET}`)
  const result = await runHeartbeat()

  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  if (result.tasksRun.length === 0) {
    console.log(`${DIM}No scheduled tasks due.${RESET}`)
  } else {
    console.log(`${GREEN}✓${RESET} Ran ${result.tasksRun.length} task(s):`)
    for (const t of result.tasksRun) {
      const ok = t.exitCode === 0
      console.log(
        `  ${ok ? `${GREEN}✓` : `${MAGENTA}✗`}${RESET} ${t.entry.prompt.slice(0, 70)} ${DIM}(${(t.durationMs / 1000).toFixed(1)}s${t.timedOut ? ", timed out" : ""})${RESET}`,
      )
      if (t.output) {
        for (const line of t.output.split("\n").slice(0, 10)) {
          console.log(`    ${DIM}${line}${RESET}`)
        }
      }
    }
  }

  if (result.activeGoals.length > 0) {
    console.log(``)
    console.log(`${MAGENTA}Active goals${RESET} (${result.activeGoals.length}):`)
    for (const title of result.activeGoals) console.log(`  ● ${title}`)
  }

  if (result.evolveTriggered) {
    console.log(`${DIM}Experience fast loop triggered (MOMO_XP_AUTO).${RESET}`)
  }
}
