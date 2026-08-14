/**
 * /daemon command — long-running foreground loop for scheduled work.
 *
 *   momo /daemon [--interval=60]
 *
 * Polls the schedule every `--interval` seconds (default: 60,
 * MOMO_DAEMON_INTERVAL) and runs one heartbeat pass when anything is due.
 *
 * Budget rails:
 *   MOMO_DAEMON_MAX_RUNS   stop after N heartbeat passes (default: unlimited)
 *   MOMO_DAEMON_MAX_HOURS  stop after N hours (default: 24)
 *
 * This is a foreground process by design — use nohup / systemd /
 * Task Scheduler to background it.
 */
import { runHeartbeat } from "../../schedule/runner.js"
import { dueEntries } from "../../schedule/store.js"

const GREEN = "\x1b[32m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const MAGENTA = "\x1b[95m"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function runDaemonCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`${MAGENTA}momo /daemon${RESET} — long-running scheduled-work loop`)
    console.log(``)
    console.log(`Usage: momo /daemon [--interval=60]`)
    console.log(``)
    console.log(`Env:`)
    console.log(`  MOMO_DAEMON_INTERVAL   Poll interval seconds (default: 60)`)
    console.log(`  MOMO_DAEMON_MAX_RUNS   Stop after N heartbeat passes (default: unlimited)`)
    console.log(`  MOMO_DAEMON_MAX_HOURS  Stop after N hours (default: 24)`)
    console.log(``)
    console.log(`Foreground process — background with nohup/systemd/Task Scheduler.`)
    return
  }

  let intervalSec = Number(process.env.MOMO_DAEMON_INTERVAL || 60) || 60
  for (const a of args) {
    if (a.startsWith("--interval=")) {
      intervalSec = Number(a.slice(11)) || intervalSec
    }
  }
  const maxRuns = Number(process.env.MOMO_DAEMON_MAX_RUNS || 0) || Infinity
  const maxHours = Number(process.env.MOMO_DAEMON_MAX_HOURS || 24) || 24
  const deadline = Date.now() + maxHours * 3_600_000

  console.log(`${MAGENTA}momo daemon${RESET} started (pid ${process.pid})`)
  console.log(
    `${DIM}  interval: ${intervalSec}s · max runs: ${maxRuns === Infinity ? "∞" : maxRuns} · max hours: ${maxHours}${RESET}`,
  )
  console.log(`${DIM}  stop with Ctrl+C${RESET}`)

  let runs = 0
  let stopped = false
  process.on("SIGINT", () => {
    stopped = true
  })
  process.on("SIGTERM", () => {
    stopped = true
  })

  while (!stopped && runs < maxRuns && Date.now() < deadline) {
    if (dueEntries().length > 0) {
      runs++
      console.log(`${DIM}→ heartbeat #${runs} ${new Date().toISOString()}${RESET}`)
      const result = await runHeartbeat()
      for (const t of result.tasksRun) {
        const ok = t.exitCode === 0
        console.log(
          `  ${ok ? `${GREEN}✓` : `${MAGENTA}✗`}${RESET} ${t.entry.prompt.slice(0, 70)} ${DIM}(${(t.durationMs / 1000).toFixed(1)}s)${RESET}`,
        )
      }
    }
    await sleep(intervalSec * 1000)
  }

  console.log(
    `${DIM}daemon stopped (${runs} heartbeat pass(es)${Date.now() >= deadline ? ", time budget exhausted" : ""})${RESET}`,
  )
}
