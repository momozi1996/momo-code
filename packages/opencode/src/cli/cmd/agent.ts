/**
 * /agent command — recursive subagent orchestration (process-level RLM).
 *
 *   momo /agent "<task>" [--json]
 *
 * The task is decomposed by the model into subtasks, each executed by a
 * child momo process (parallel where possible), then synthesized into a
 * final answer.
 */
import { orchestrate } from "../../subagent/orchestrate.js"
import { currentDepth, maxDepth } from "../../subagent/spawn.js"

const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const MAGENTA = "\x1b[95m"

export async function runAgentCommand(args: string[]): Promise<void> {
  const json = args.includes("--json")
  const task = args.filter((a) => a !== "--json").join(" ").trim()

  if (!task || args.includes("--help") || args.includes("-h")) {
    console.log(`${MAGENTA}momo /agent${RESET} — recursive subagent orchestration`)
    console.log(``)
    console.log(`Usage: momo /agent "<complex task>" [--json]`)
    console.log(``)
    console.log(`Decomposes the task, runs subagents as child processes,`)
    console.log(`then synthesizes a final answer (RLM-style recursion).`)
    console.log(``)
    console.log(`Env: MOMO_RLM_MAX_DEPTH (3), MOMO_RLM_BUDGET (8), MOMO_RLM_TIMEOUT_MS (300000)`)
    return
  }

  console.error(
    `${DIM}→ orchestrating (depth ${currentDepth()}/${maxDepth()})…${RESET}`,
  )
  const result = await orchestrate(task)

  if (json) {
    console.log(
      JSON.stringify(
        {
          mode: result.mode,
          subtasks: result.subtasks,
          results: result.results.map((r) => ({
            task: r.task,
            exitCode: r.exitCode,
            durationMs: r.durationMs,
            timedOut: r.timedOut,
            output: r.output,
          })),
          synthesis: result.synthesis,
          error: result.error,
        },
        null,
        2,
      ),
    )
    return
  }

  if (result.error && !result.synthesis) {
    console.error(`${MAGENTA}/agent${RESET}: ${result.error}`)
    process.exit(1)
  }

  if (result.mode === "decomposed") {
    console.error(
      `${DIM}→ decomposed into ${result.subtasks.length} subtask(s)${RESET}`,
    )
    for (const [i, r] of result.results.entries()) {
      const ok = r.exitCode === 0
      console.error(
        `  ${ok ? `${GREEN}✓` : `${MAGENTA}✗`}${RESET} ${CYAN}[${i + 1}]${RESET} ${r.task.slice(0, 80)} ${DIM}(${(r.durationMs / 1000).toFixed(1)}s${r.timedOut ? ", timed out" : ""})${RESET}`,
      )
    }
    console.error(``)
  }

  console.log(result.synthesis)
  if (result.results.some((r) => r.exitCode !== 0)) process.exit(1)
}
