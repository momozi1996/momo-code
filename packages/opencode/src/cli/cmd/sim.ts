/**
 * /sim command — Genesis world simulation agent.
 *
 *   momo /sim doctor                 Environment self-check
 *   momo /sim exec "<python>"        Run code once in a fresh world
 *   momo /sim run "<task>" [--steps=N] [--viewer] [--json]
 *                                    LLM autonomous control loop
 *   momo /sim skills                 List skills in ~/.momo/sim/skills
 *
 * Results of /sim run are recorded as session trajectories, feeding the
 * /refine self-improvement loop.
 */
import * as fs from "fs"
import * as path from "path"
import { SimBridge } from "../../sim/bridge.js"
import { runSimLoop } from "../../sim/loop.js"
import { runEval, saveReport, type EvalTask } from "../../sim/eval.js"
import { recordSession, getMomoHome } from "../../session/recorder.js"
import { resolveProviderConfig } from "../chat.js"

const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const MAGENTA = "\x1b[95m"

function getSkillsDir(): string {
  return path.join(getMomoHome(), "sim", "skills")
}

function printUsage(): void {
  console.log(`${MAGENTA}momo /sim${RESET} — Genesis world simulation agent`)
  console.log(``)
  console.log(`Usage:`)
  console.log(`  momo /sim doctor                       Environment self-check`)
  console.log(`  momo /sim exec "<python>" [--file=x.py]   Run code in a fresh world`)
  console.log(`  momo /sim run "<task>" [options]       LLM autonomous control loop`)
  console.log(`  momo /sim skills                       List installed world skills`)
  console.log(`  momo /sim eval --tasks=x.json [-episodes=N]  Batch evaluation`)
  console.log(``)
  console.log(`Options: --steps=N  --viewer  --backend=cpu|gpu  --file=x.py  --json`)
  console.log(``)
  console.log(`Env: MOMO_SIM_PYTHON, MOMO_SIM_BACKEND, MOMO_SIM_MAX_STEPS (20)`)
  console.log(`Skills: drop .py files into ~/.momo/sim/skills/ — they load into every world`)
}

// ---------------------------------------------------------------------------
// Sub-commands
// ---------------------------------------------------------------------------

async function simDoctor(): Promise<void> {
  console.log(`${MAGENTA}/sim doctor${RESET}`)
  console.log(``)

  const python = process.env.MOMO_SIM_PYTHON || "python"
  console.log(`python:   ${CYAN}${python}${RESET}`)

  const bridge = new SimBridge()
  const start = Date.now()
  try {
    await bridge.request("ping", {}, { timeoutMs: 30_000 })
    console.log(`server:   ${GREEN}✓${RESET} genesis_world server responds`)
  } catch (err) {
    console.log(`server:   ${MAGENTA}✗${RESET} ${err instanceof Error ? err.message : err}`)
    console.log(`          ${DIM}server path: ${SimBridge.defaultServerPath()}${RESET}`)
    await bridge.close()
    process.exit(1)
  }

  try {
    const init = await bridge.initWorld({})
    console.log(`genesis:  ${GREEN}✓${RESET} v${init.genesis_version} (backend: ${init.backend}, init ${((Date.now() - start) / 1000).toFixed(1)}s)`)
  } catch (err) {
    console.log(`genesis:  ${MAGENTA}✗${RESET} ${err instanceof Error ? err.message : err}`)
  }

  const provider = await resolveProviderConfig()
  if (provider && provider.baseUrl) {
    console.log(`provider: ${GREEN}✓${RESET} ${provider.providerName} | ${provider.model}`)
  } else {
    console.log(`provider: ${YELLOW}!${RESET} no LLM provider configured — /sim run needs MOMO_API_KEY`)
  }

  const skillsDir = getSkillsDir()
  const skills = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir).filter((f) => f.endsWith(".py"))
    : []
  console.log(`skills:   ${skills.length > 0 ? `${skills.length} installed` : `${DIM}none${RESET}`} ${DIM}(${skillsDir})${RESET}`)

  await bridge.close()
}

async function simExec(code: string): Promise<void> {
  const bridge = new SimBridge()
  const execTimeout = Number(process.env.MOMO_SIM_EXEC_TIMEOUT_MS || 600_000) || 600_000
  try {
    console.error(`${DIM}→ initializing world…${RESET}`)
    await bridge.initWorld({})
    const result = await bridge.exec(code, execTimeout)
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.error) {
      console.error(`${MAGENTA}✗${RESET} ${result.error}`)
      process.exit(1)
    }
  } finally {
    await bridge.close()
  }
}

async function simRun(task: string, args: string[]): Promise<void> {
  let maxSteps: number | undefined
  let viewer = false
  let backend: string | undefined
  let json = false
  for (const a of args) {
    if (a.startsWith("--steps=")) maxSteps = Number(a.slice(8)) || undefined
    else if (a === "--viewer") viewer = true
    else if (a.startsWith("--backend=")) backend = a.slice(10)
    else if (a === "--json") json = true
  }

  const bridge = new SimBridge()
  const startMs = Date.now()
  try {
    console.error(`${DIM}→ starting world + agent loop (budget: ${maxSteps ?? (Number(process.env.MOMO_SIM_MAX_STEPS || 20) || 20)} steps)…${RESET}`)
    const result = await runSimLoop(task, bridge, {
      ...(maxSteps ? { maxSteps } : {}),
      viewer,
      ...(backend ? { backend } : {}),
    })

    // Record trajectory — feeds /refine (awaited so the write lands
    // before the process exits)
    const transcript = result.turns
      .map((t) => `--- step ${t.step} ---\n${t.thought}\n${t.code}\n${t.stdout}${t.error ? `\nERROR: ${t.error}` : ""}`)
      .join("\n\n")
    await recordSession({
      provider: "sim",
      model: "sim-loop",
      prompt: `[sim] ${task}`,
      response: `${result.done ? "DONE" : "FAILED"}: ${result.summary || result.error || ""}\n\n${transcript}`,
      exitCode: result.done ? 0 : 1,
      durationMs: Date.now() - startMs,
      rlmDepth: Number(process.env.MOMO_RLM_DEPTH || 0) || 0,
    })

    if (json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }

    for (const t of result.turns) {
      if (!t.code && t.error) {
        console.error(`  ${YELLOW}!${RESET} ${t.error.split("\n")[0]}`)
        continue
      }
      console.error(
        `  ${CYAN}[${t.step}]${RESET} ${t.thought.slice(0, 100)}${t.error ? ` ${MAGENTA}(error)${RESET}` : ""}`,
      )
      if (t.stdout.trim()) {
        for (const line of t.stdout.trim().split("\n").slice(0, 5)) {
          console.error(`      ${DIM}${line}${RESET}`)
        }
      }
    }
    console.error(``)

    if (result.done) {
      console.log(`${GREEN}✓ DONE${RESET} ${result.summary}`)
    } else {
      console.error(`${MAGENTA}✗ FAILED${RESET} ${result.error || "unknown"}`)
      process.exit(1)
    }
  } finally {
    await bridge.close()
  }
}

function simSkills(): void {
  const dir = getSkillsDir()
  if (!fs.existsSync(dir)) {
    console.log(`${DIM}No skills directory yet: ${dir}${RESET}`)
    console.log(`${DIM}Create it and drop .py files — they load into every world namespace.${RESET}`)
    return
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".py") && !f.startsWith("_"))
  if (files.length === 0) {
    console.log(`${DIM}No skills installed. Drop .py files into ${dir}${RESET}`)
    return
  }
  console.log(`${MAGENTA}World skills${RESET} (${files.length}) — ${DIM}${dir}${RESET}:`)
  for (const f of files) {
    const firstDocLine = fs
      .readFileSync(path.join(dir, f), "utf-8")
      .split("\n")
      .find((l) => l.trim().startsWith('"""') || l.trim().startsWith("#"))
    console.log(`  ${CYAN}${f}${RESET}${firstDocLine ? ` ${DIM}${firstDocLine.trim().replace(/^#+\s*/, "")}${RESET}` : ""}`)
  }
}

async function simEval(args: string[]): Promise<void> {
  let tasksFile: string | undefined
  let episodes = 1
  let json = false
  for (const a of args) {
    if (a.startsWith("--tasks=")) tasksFile = a.slice(8)
    else if (a.startsWith("--episodes=")) episodes = Number(a.slice(11)) || 1
    else if (a === "--json") json = true
  }
  if (!tasksFile || !fs.existsSync(tasksFile)) {
    console.error(`Usage: momo /sim eval --tasks=<file.json> [--episodes=N] [--json]`)
    console.error(`tasks file: [{"task": "...", "max_steps": 15}, ...]`)
    process.exit(1)
  }

  let tasks: EvalTask[]
  try {
    const raw = JSON.parse(fs.readFileSync(tasksFile, "utf-8"))
    if (!Array.isArray(raw)) throw new Error("expected a JSON array")
    tasks = raw.filter((t) => t && typeof t.task === "string")
  } catch (err) {
    console.error(`Invalid tasks file: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
  if (tasks.length === 0) {
    console.error(`No valid tasks in ${tasksFile}`)
    process.exit(1)
  }

  console.error(
    `${DIM}→ evaluating ${tasks.length} task(s) × ${episodes} episode(s)…${RESET}`,
  )
  const report = await runEval(tasks, episodes, (r) => {
    if (!json) {
      const mark = r.success ? `${GREEN}✓` : `${MAGENTA}✗`
      console.error(
        `  ${mark}${RESET} [${r.episode}] ${r.task.slice(0, 60)} ${DIM}(${r.steps} steps, ${(r.durationMs / 1000).toFixed(0)}s)${RESET}`,
      )
    }
  })

  const file = saveReport(report)
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  const m = report.metrics
  console.log(``)
  console.log(`${MAGENTA}Eval report${RESET} — ${DIM}${file}${RESET}`)
  console.log(`  success rate: ${GREEN}${(m.successRate * 100).toFixed(0)}%${RESET} (${m.successes}/${m.episodes})`)
  console.log(`  avg steps:    ${m.avgSteps}`)
  console.log(`  avg duration: ${(m.avgDurationMs / 1000).toFixed(1)}s`)
  if (m.successRate < 1) process.exit(1)
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runSimCommand(args: string[]): Promise<void> {
  const sub = args[0]
  const rest = args.slice(1).filter((a) => !a.startsWith("--"))

  switch (sub) {
    case "doctor":
      await simDoctor()
      return
    case "exec": {
      let code = rest.join(" ")
      const fileArg = args.find((a) => a.startsWith("--file="))
      if (fileArg) {
        const file = fileArg.slice(7)
        if (!fs.existsSync(file)) {
          console.error(`File not found: ${file}`)
          process.exit(1)
        }
        code = fs.readFileSync(file, "utf-8")
      }
      if (!code) {
        console.error(`Usage: momo /sim exec "<python code>"  or  momo /sim exec --file=script.py`)
        process.exit(1)
      }
      await simExec(code)
      return
    }
    case "run": {
      const task = rest.join(" ")
      if (!task) {
        console.error(`Usage: momo /sim run "<task>" [--steps=N] [--viewer]`)
        process.exit(1)
      }
      await simRun(task, args.slice(1))
      return
    }
    case "skills":
      simSkills()
      return
    case "eval":
      await simEval(args.slice(1))
      return
    default:
      if (sub && !sub.startsWith("--")) {
        console.error(`Unknown /sim sub-command: ${sub}`)
      }
      printUsage()
      if (sub && !sub.startsWith("--")) process.exit(1)
  }
}
