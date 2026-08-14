/**
 * Subagent spawning — process-level recursive language model (RLM).
 *
 * Inspired by Prime Agent's `rlm(...)`: a subagent is a function call.
 * Here the "call" is a child `momo` process — process isolation gives us
 * context isolation and parallelism for free, and child runs inherit the
 * full provider/tactic-injection/trajectory-recording pipeline.
 *
 * Safety rails:
 *   - `MOMO_RLM_DEPTH`      current recursion depth (auto-incremented)
 *   - `MOMO_RLM_MAX_DEPTH`  hard recursion limit (default: 3)
 *   - `MOMO_RLM_TIMEOUT_MS` per-subagent timeout (default: 300_000)
 *
 * @module subagent/spawn
 */

import { spawn } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubagentResult {
  readonly task: string
  readonly output: string
  /** Diagnostics captured on stderr (logs, reasoning, warnings). */
  readonly stderrOutput: string
  readonly exitCode: number
  readonly durationMs: number
  readonly timedOut: boolean
  readonly depth: number
  /** Token usage reported by the child (via MOMO_USAGE_FILE), if any. */
  readonly tokens?: { prompt?: number; completion?: number; total?: number }
}

export interface SpawnOpts {
  /** Extra environment variables for the child process */
  readonly env?: Record<string, string>
  /** Timeout in ms (default: MOMO_RLM_TIMEOUT_MS or 300_000) */
  readonly timeoutMs?: number
  /**
   * Explicit argv to append after the base args (instead of `[task]`).
   * Lets a subagent dispatch to CLI commands, e.g. ["/sim", "run", task].
   */
  readonly args?: string[]
}

/** Read + delete the child's usage report written to `file`. */
function readUsageFile(
  file: string,
): { prompt?: number; completion?: number; total?: number } | undefined {
  try {
    if (!fs.existsSync(file)) return undefined
    const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>
    fs.unlinkSync(file)
    const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined)
    // The child writes camelCase (promptTokens…); older writers may use prompt/…
    const prompt = num(raw.promptTokens ?? raw.prompt)
    const completion = num(raw.completionTokens ?? raw.completion)
    const total = num(raw.totalTokens ?? raw.total)
    return prompt !== undefined || completion !== undefined || total !== undefined
      ? { prompt, completion, total }
      : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Depth guard
// ---------------------------------------------------------------------------

export function currentDepth(): number {
  return Number(process.env.MOMO_RLM_DEPTH || 0) || 0
}

export function maxDepth(): number {
  return Number(process.env.MOMO_RLM_MAX_DEPTH || 3) || 3
}

/** True when spawning another subagent level is allowed. */
export function canSpawn(): boolean {
  return currentDepth() < maxDepth()
}

// ---------------------------------------------------------------------------
// Self-invocation
// ---------------------------------------------------------------------------

/**
 * Resolve how to re-invoke the current momo entry point.
 * - node/bun running a script entry (.js or extension-less bin shim)
 *   → `<exec> <script>`
 * - dev runtime (.ts entry under tsx) → `node <npm-cli> exec -- tsx <script>`
 *   (spawning npx.cmd directly is blocked on Windows)
 * - compiled binary (argv[1] is the prompt, not a file) → `<binary>`
 */
export function selfCommand(): { cmd: string; baseArgs: string[] } {
  const script = process.argv[1]
  if (script && script !== process.execPath && fs.existsSync(script)) {
    if (/\.ts$/.test(script)) {
      const npmCli = process.env.npm_execpath
      if (npmCli && fs.existsSync(npmCli)) {
        return {
          cmd: process.execPath,
          baseArgs: [npmCli, "exec", "--", "tsx", script, "--"],
        }
      }
      // No npm context — tsx must be invoked some other way; give up
      // with a clear signal rather than a broken spawn.
      return { cmd: "", baseArgs: [] }
    }
    return { cmd: process.execPath, baseArgs: [script] }
  }
  return { cmd: process.execPath, baseArgs: [] }
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

/**
 * Spawn a subagent for `task` and capture its full output.
 * Never throws — failures are reported via exitCode/output.
 */
export function spawnSubagent(
  task: string,
  opts: SpawnOpts = {},
): Promise<SubagentResult> {
  const depth = currentDepth() + 1
  const timeoutMs =
    opts.timeoutMs ?? (Number(process.env.MOMO_RLM_TIMEOUT_MS || 300_000) || 300_000)
  const started = Date.now()
  const usageFile = path.join(
    os.tmpdir(),
    `momo-usage-${process.pid}-${started}-${Math.random().toString(36).slice(2, 8)}.json`,
  )

  return new Promise((resolve) => {
    const done = (output: string, stderrOutput: string, exitCode: number, timedOut: boolean) =>
      resolve({
        task,
        output,
        stderrOutput,
        exitCode,
        durationMs: Date.now() - started,
        timedOut,
        depth,
        tokens: readUsageFile(usageFile),
      })

    if (depth > maxDepth()) {
      done(
        `RLM depth limit reached (max ${maxDepth()}) — refusing to spawn deeper subagent`,
        "",
        1,
        false,
      )
      return
    }

    const { cmd, baseArgs } = selfCommand()
    let child
    try {
      if (!cmd) {
        done(
          "cannot re-invoke momo: running from TypeScript source outside an npm/tsx context — run via `npx tsx` or build first (npm run build)",
          "",
          1,
          false,
        )
        return
      }
      child = spawn(cmd, [...baseArgs, ...(opts.args ?? [task])], {
        env: {
          ...process.env,
          MOMO_RLM_DEPTH: String(depth),
          MOMO_USAGE_FILE: usageFile,
          ...opts.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (err) {
      done(
        `failed to spawn subagent: ${err instanceof Error ? err.message : String(err)}`,
        "",
        1,
        false,
      )
      return
    }

    let stdoutBuf = ""
    let stderrBuf = ""
    let finished = false
    const finish = (exitCode: number, timedOut: boolean) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      done(stdoutBuf.trim(), stderrBuf.trim(), exitCode, timedOut)
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM")
      } catch {
        /* ignore */
      }
      stderrBuf += "\n[subagent timed out]"
      finish(124, true)
    }, timeoutMs)

    child.stdout?.on("data", (d: Buffer) => {
      stdoutBuf += d.toString()
    })
    child.stderr?.on("data", (d: Buffer) => {
      stderrBuf += d.toString()
    })
    child.on("error", (err) => {
      stderrBuf += `\n[spawn error: ${err.message}]`
      finish(1, false)
    })
    child.on("close", (code) => finish(code ?? 1, false))
  })
}
