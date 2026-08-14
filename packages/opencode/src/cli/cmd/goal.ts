/**
 * /goal command — persistent long-term goals.
 *
 *   momo /goal add "<title>" [detail...]   Create a goal
 *   momo /goal list [--json]               List goals
 *   momo /goal log <id> "<note>"           Record progress
 *   momo /goal done <id>                   Mark complete
 *   momo /goal rm <id>                     Delete a goal
 *
 * Active goals are injected into every chat session's system prompt.
 */
import {
  addGoal,
  findGoal,
  loadGoals,
  removeGoal,
  updateGoal,
} from "../../goal/store.js"

const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const MAGENTA = "\x1b[95m"

export function runGoalCommand(args: string[]): void {
  const sub = args[0]
  const json = args.includes("--json")

  switch (sub) {
    case "add": {
      const rest = args.slice(1).filter((a) => !a.startsWith("--"))
      const title = rest[0]
      if (!title) {
        console.error(`Usage: momo /goal add "<title>" [detail...]`)
        process.exit(1)
      }
      const goal = addGoal(title, rest.slice(1).join(" ") || undefined)
      console.log(`${GREEN}✓${RESET} Goal created: ${CYAN}${goal.id}${RESET} ${goal.title}`)
      return
    }

    case "list": {
      const goals = loadGoals()
      if (json) {
        console.log(JSON.stringify(goals, null, 2))
        return
      }
      if (goals.length === 0) {
        console.log(`${DIM}No goals yet. Create one: momo /goal add "<title>"${RESET}`)
        return
      }
      console.log(`${MAGENTA}Goals${RESET} (${goals.length}):`)
      for (const g of goals) {
        const mark = g.status === "done" ? `${GREEN}✓` : `${CYAN}●`
        console.log(
          `  ${mark}${RESET} ${CYAN}${g.id}${RESET} ${g.title} ${DIM}(${g.status}, ${g.log.length} log entries, updated ${g.updatedAt.slice(0, 10)})${RESET}`,
        )
        const last = g.log[g.log.length - 1]
        if (last && g.status === "active") {
          console.log(`    ${DIM}latest: ${last.note}${RESET}`)
        }
      }
      return
    }

    case "log": {
      const id = args[1]
      const note = args.slice(2).join(" ").trim()
      if (!id || !note) {
        console.error(`Usage: momo /goal log <id> "<note>"`)
        process.exit(1)
      }
      const g = updateGoal(id, (goal) => {
        goal.log.push({ ts: new Date().toISOString(), note })
      })
      if (!g) {
        console.error(`Goal not found: ${id}`)
        process.exit(1)
      }
      console.log(`${GREEN}✓${RESET} Logged progress on ${CYAN}${g.id}${RESET}`)
      return
    }

    case "done": {
      const id = args[1]
      if (!id) {
        console.error(`Usage: momo /goal done <id>`)
        process.exit(1)
      }
      const g = updateGoal(id, (goal) => {
        goal.status = "done"
        goal.log.push({ ts: new Date().toISOString(), note: "goal completed" })
      })
      if (!g) {
        console.error(`Goal not found: ${id}`)
        process.exit(1)
      }
      console.log(`${GREEN}✓${RESET} Goal completed: ${CYAN}${g.id}${RESET} ${g.title}`)
      return
    }

    case "rm":
    case "remove": {
      const id = args[1]
      if (!id || !removeGoal(id)) {
        console.error(`Goal not found: ${id ?? "(missing id)"}`)
        process.exit(1)
      }
      console.log(`${GREEN}✓${RESET} Goal removed: ${id}`)
      return
    }

    default: {
      if (sub && !sub.startsWith("--")) {
        console.error(`Unknown /goal sub-command: ${sub}`)
      }
      console.log(`${MAGENTA}momo /goal${RESET} — persistent long-term goals`)
      console.log(``)
      console.log(`Usage:`)
      console.log(`  momo /goal add "<title>" [detail...]`)
      console.log(`  momo /goal list [--json]`)
      console.log(`  momo /goal log <id> "<note>"`)
      console.log(`  momo /goal done <id>`)
      console.log(`  momo /goal rm <id>`)
      if (sub && !sub.startsWith("--")) process.exit(1)
    }
  }
}

/** Re-export for heartbeat: unresolved goals reminder. */
export { findGoal }
