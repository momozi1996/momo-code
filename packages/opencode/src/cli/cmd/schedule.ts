/**
 * /schedule command — manage timed tasks for heartbeat/daemon.
 *
 *   momo /schedule add --every=60m "<prompt>"    Run every N minutes
 *   momo /schedule add --at=07:30 "<prompt>"     Run once daily at HH:MM
 *   momo /schedule list [--json]                 List entries
 *   momo /schedule rm <id>                       Remove an entry
 */
import {
  addScheduleEntry,
  loadSchedule,
  removeScheduleEntry,
} from "../../schedule/store.js"

const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const MAGENTA = "\x1b[95m"

function parseEvery(value: string): number | null {
  const m = /^(\d+)(m|h|d)?$/.exec(value.trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2] ?? "m"
  const mult = unit === "h" ? 60 : unit === "d" ? 1440 : 1
  return n * mult
}

export function runScheduleCommand(args: string[]): void {
  const sub = args[0]
  const json = args.includes("--json")

  switch (sub) {
    case "add": {
      let intervalMin: number | undefined
      let dailyAt: string | undefined
      const rest: string[] = []
      for (const a of args.slice(1)) {
        if (a.startsWith("--every=")) {
          const parsed = parseEvery(a.slice(8))
          if (!parsed) {
            console.error(`Invalid --every value: ${a.slice(8)} (use e.g. 30m, 2h, 1d)`)
            process.exit(1)
          }
          intervalMin = parsed
        } else if (a.startsWith("--at=")) {
          if (!/^\d{1,2}:\d{2}$/.test(a.slice(5))) {
            console.error(`Invalid --at value: ${a.slice(5)} (use HH:MM)`)
            process.exit(1)
          }
          dailyAt = a.slice(5)
        } else if (!a.startsWith("--")) {
          rest.push(a)
        }
      }
      const prompt = rest.join(" ").trim()
      if (!prompt || (!intervalMin && !dailyAt)) {
        console.error(`Usage: momo /schedule add --every=60m "<prompt>"  or  --at=HH:MM "<prompt>"`)
        process.exit(1)
      }
      const entry = addScheduleEntry(prompt, {
        ...(intervalMin ? { intervalMin } : {}),
        ...(dailyAt ? { dailyAt } : {}),
      })
      console.log(
        `${GREEN}✓${RESET} Scheduled: ${CYAN}${entry.id}${RESET} ${intervalMin ? `every ${intervalMin}min` : `daily at ${dailyAt}`} — "${prompt.slice(0, 60)}"`,
      )
      return
    }

    case "list": {
      const entries = loadSchedule()
      if (json) {
        console.log(JSON.stringify(entries, null, 2))
        return
      }
      if (entries.length === 0) {
        console.log(`${DIM}No scheduled tasks. Add one: momo /schedule add --every=60m "<prompt>"${RESET}`)
        return
      }
      console.log(`${MAGENTA}Schedule${RESET} (${entries.length}):`)
      for (const e of entries) {
        const cadence = e.intervalMin ? `every ${e.intervalMin}min` : `daily at ${e.dailyAt}`
        const last = e.lastRunAt ? e.lastRunAt.slice(0, 16).replace("T", " ") : "never"
        console.log(
          `  ${e.enabled ? `${GREEN}●` : `${DIM}○`}${RESET} ${CYAN}${e.id}${RESET} ${cadence} ${DIM}(last: ${last})${RESET} — ${e.prompt.slice(0, 60)}`,
        )
      }
      return
    }

    case "rm":
    case "remove": {
      const id = args[1]
      if (!id || !removeScheduleEntry(id)) {
        console.error(`Schedule entry not found: ${id ?? "(missing id)"}`)
        process.exit(1)
      }
      console.log(`${GREEN}✓${RESET} Removed: ${id}`)
      return
    }

    default: {
      if (sub && !sub.startsWith("--")) {
        console.error(`Unknown /schedule sub-command: ${sub}`)
      }
      console.log(`${MAGENTA}momo /schedule${RESET} — timed tasks for heartbeat/daemon`)
      console.log(``)
      console.log(`Usage:`)
      console.log(`  momo /schedule add --every=60m "<prompt>"`)
      console.log(`  momo /schedule add --at=07:30 "<prompt>"`)
      console.log(`  momo /schedule list [--json]`)
      console.log(`  momo /schedule rm <id>`)
      if (sub && !sub.startsWith("--")) process.exit(1)
    }
  }
}
