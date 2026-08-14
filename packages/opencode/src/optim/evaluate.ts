/**
 * Optim evaluators — how a proposed configuration is measured.
 *
 * Two modes:
 *   - cmd — generic business logic: run a shell command with `{param}`
 *     placeholders substituted, parse the metric from stdout
 *     (`<metric>=<float>` line, or a JSON object containing the key).
 *   - sim — physics: run an experiment in the persistent Genesis world
 *     via SimBridge (ESTOP honored — an emergency stop marks the trial
 *     failed instead of crashing the study), then evaluate a metric
 *     expression in the world namespace.
 *
 * @module optim/evaluate
 */

import { execFile } from "child_process"
import { SimBridge } from "../sim/bridge.js"
import type { EvaluatorSpec, ParamValue } from "./study.js"

// ---------------------------------------------------------------------------
// Placeholder substitution (pure — unit-tested)
// ---------------------------------------------------------------------------

/** Substitute `{name}` placeholders with parameter values. */
export function substituteParams(
  template: string,
  params: Record<string, ParamValue>,
): string {
  return template.replace(/\{(\w+)\}/g, (m, name) =>
    params[name] !== undefined ? String(params[name]) : m,
  )
}

// ---------------------------------------------------------------------------
// Metric parsing (pure — unit-tested)
// ---------------------------------------------------------------------------

/**
 * Parse the metric value from evaluator stdout. Looks for the LAST
 * `<key>=<float>` line first, then a JSON object containing the key.
 * Throws when the metric is absent.
 */
export function parseMetric(stdout: string, key: string): number {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(-?[0-9.eE+]+)\\s*$`, "gm")
  let match: RegExpExecArray | null
  let last: string | undefined
  while ((match = re.exec(stdout)) !== null) last = match[1]
  if (last !== undefined) {
    const v = Number(last)
    if (Number.isFinite(v)) return v
  }

  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      const v = Number(obj[key])
      if (Number.isFinite(v)) return v
    } catch {
      // not a JSON line — keep scanning
    }
  }
  throw new Error(`metric "${key}" not found in evaluator output`)
}

// ---------------------------------------------------------------------------
// cmd evaluator
// ---------------------------------------------------------------------------

const CMD_TIMEOUT_MS = 600_000

/** Run the business command with substituted params; return the metric. */
export function evaluateCmd(
  cmdTemplate: string,
  params: Record<string, ParamValue>,
  metricKey: string,
): Promise<{ value: number; output: string }> {
  const cmd = substituteParams(cmdTemplate, params)
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  for (const [k, v] of Object.entries(params)) {
    env[`OPTIM_${k.toUpperCase()}`] = String(v)
  }
  return new Promise((resolve, reject) => {
    execFile(
      process.platform === "win32" ? "cmd" : "sh",
      process.platform === "win32" ? ["/c", cmd] : ["-c", cmd],
      { env, timeout: CMD_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim()
        try {
          const value = parseMetric(stdout, metricKey)
          resolve({ value, output })
        } catch (parseErr) {
          reject(
            new Error(
              `${parseErr instanceof Error ? parseErr.message : parseErr}` +
                (err ? ` (command exited with ${(err as any).code ?? "error"})` : "") +
                `\n--- evaluator output (tail) ---\n${output.slice(-1000)}`,
            ),
          )
        }
      },
    )
  })
}

// ---------------------------------------------------------------------------
// sim evaluator (Genesis world via SimBridge)
// ---------------------------------------------------------------------------

/**
 * Run the experiment code in the persistent world, then evaluate the
 * metric expression. The ESTOP flag is checked first — an active
 * emergency stop fails the trial instead of running the experiment.
 */
export async function evaluateSim(
  bridge: SimBridge,
  taskTemplate: string,
  metricExpr: string,
  params: Record<string, ParamValue>,
): Promise<{ value: number; output: string }> {
  const estop = await bridge.evalExpr("ESTOP")
  if (estop.repr === "True") {
    throw new Error("ESTOP active — refusing to run the experiment")
  }
  const code = substituteParams(taskTemplate, params)
  const execResult = await bridge.exec(code)
  if (execResult.error) {
    throw new Error(`experiment failed: ${execResult.error.slice(-500)}`)
  }
  const metric = await bridge.evalExpr(metricExpr)
  const value = Number(metric.repr)
  if (!Number.isFinite(value)) {
    throw new Error(`metric expression "${metricExpr}" did not evaluate to a number (got ${metric.repr})`)
  }
  return { value, output: execResult.stdout.slice(-1000) }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface EvalContext {
  /** Required when the evaluator is kind==="sim" (owned by the runner) */
  bridge?: SimBridge
}

export async function evaluate(
  spec: EvaluatorSpec,
  metricKey: string,
  params: Record<string, ParamValue>,
  ctx: EvalContext = {},
): Promise<{ value: number; output: string }> {
  if (spec.kind === "cmd") {
    return evaluateCmd(spec.cmd, params, metricKey)
  }
  if (!ctx.bridge) throw new Error("sim evaluator requires an active SimBridge")
  return evaluateSim(ctx.bridge, spec.task, metricKey, params)
}
