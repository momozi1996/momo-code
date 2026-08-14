/**
 * RLM orchestrator — Plan → Execute → Synthesize.
 *
 * Implements Prime Agent-style recursive decomposition on top of the
 * single-turn chat CLI:
 *
 *   1. Plan:        ask the model to split the task into subtasks (JSON),
 *                   each flagged parallelizable or sequential
 *   2. Execute:     run parallelizable subtasks concurrently via
 *                   `spawnSubagent`, then sequential ones in order,
 *                   threading prior results forward as context
 *   3. Synthesize:  ask the model to merge all subagent outputs into
 *                   one final answer
 *
 * Budget rails: at most `MOMO_RLM_BUDGET` (default 8) subagents per run.
 *
 * @module subagent/orchestrate
 */

import { chatComplete, resolveProviderConfig } from "../cli/chat.js"
import { extractJsonObject } from "../refine/propose.js"
import {
  canSpawn,
  currentDepth,
  maxDepth,
  spawnSubagent,
  type SubagentResult,
} from "./spawn.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Subtask {
  readonly task: string
  readonly parallelizable: boolean
}

export interface OrchestrateResult {
  readonly task: string
  readonly mode: "direct" | "decomposed"
  readonly subtasks: Subtask[]
  readonly results: SubagentResult[]
  readonly synthesis: string
  readonly error?: string
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

const PLANNER_SYSTEM = `You are a task decomposer for a recursive coding agent.
Given a task, decide whether to decompose it into subtasks that can be
handled by subagents.

Rules:
- Decompose only when the task clearly has independent or staged parts.
- At most 6 subtasks. Each subtask must be fully self-contained (subagents
  cannot see this conversation).
- Mark "parallelizable": true only for subtasks with no dependencies on
  other subtasks' results.
- If the task is simple or atomic, do not decompose.

Respond with ONLY a JSON object (no prose, no fences), either:
{"direct": true, "reason": "..."}
or:
{"subtasks": [{"task": "...", "parallelizable": true}, ...]}`

function parseSubtasks(raw: unknown): Subtask[] | "direct" | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as { direct?: boolean; subtasks?: unknown }
  if (obj.direct === true) return "direct"
  if (!Array.isArray(obj.subtasks)) return null
  const out: Subtask[] = []
  for (const s of obj.subtasks) {
    if (!s || typeof s !== "object") continue
    const t = (s as { task?: unknown }).task
    if (typeof t !== "string" || !t.trim()) continue
    out.push({
      task: t.trim(),
      parallelizable: (s as { parallelizable?: unknown }).parallelizable === true,
    })
  }
  return out.length ? out : null
}

// ---------------------------------------------------------------------------
// Synthesizer
// ---------------------------------------------------------------------------

const SYNTH_SYSTEM = `You are a synthesizer. Merge the subagent results below
into one coherent final answer for the user's original task.
Be concise. Preserve concrete outputs (code, decisions, findings).
Note any subagent failures explicitly instead of hiding them.`

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function orchestrate(task: string): Promise<OrchestrateResult> {
  const budget = Number(process.env.MOMO_RLM_BUDGET || 8) || 8

  const config = await resolveProviderConfig()
  if (!config || !config.baseUrl) {
    return {
      task,
      mode: "direct",
      subtasks: [],
      results: [],
      synthesis: "",
      error: "no provider configured (set MOMO_API_KEY)",
    }
  }

  const callModel = (system: string, user: string) =>
    chatComplete({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      system,
      messages: [{ role: "user", content: user }],
      stream: false,
      temperature: 0.3,
    })

  // ---- Plan ---------------------------------------------------------------
  let subtasks: Subtask[] | "direct" | null = null
  if (canSpawn()) {
    try {
      const planText = await callModel(
        PLANNER_SYSTEM,
        `Task (recursion depth ${currentDepth()}/${maxDepth()}):\n${task}`,
      )
      subtasks = parseSubtasks(extractJsonObject(planText))
    } catch {
      subtasks = null
    }
  }

  // ---- Direct execution ----------------------------------------------------
  if (subtasks === null || subtasks === "direct" || subtasks.length === 0) {
    const result = await spawnSubagent(task)
    return {
      task,
      mode: "direct",
      subtasks: [],
      results: [result],
      synthesis: result.output,
      ...(result.exitCode !== 0 ? { error: "subagent failed" } : {}),
    }
  }

  // ---- Execute --------------------------------------------------------------
  const capped = subtasks.slice(0, budget)
  const results: SubagentResult[] = []

  // Parallel batch first
  const parallel = capped.filter((s) => s.parallelizable)
  const sequential = capped.filter((s) => !s.parallelizable)

  if (parallel.length > 0) {
    const batch = await Promise.all(parallel.map((s) => spawnSubagent(s.task)))
    results.push(...batch)
  }

  // Sequential subtasks get a summary of prior results as context
  for (const s of sequential) {
    const context = results
      .map(
        (r, i) =>
          `--- result of subtask ${i + 1}: ${r.task} ---\n${r.output.slice(0, 2000)}`,
      )
      .join("\n\n")
    const prompt = context
      ? `Original task: ${task}\n\nPrior subagent results:\n${context}\n\nYour subtask: ${s.task}`
      : s.task
    results.push(await spawnSubagent(prompt))
  }

  // ---- Synthesize -------------------------------------------------------------
  let synthesis: string
  try {
    const evidence = results
      .map(
        (r, i) =>
          `--- subtask ${i + 1}: ${r.task} (exit=${r.exitCode}${r.timedOut ? ", timed out" : ""}) ---\n${r.output.slice(0, 3000)}`,
      )
      .join("\n\n")
    synthesis = await callModel(
      SYNTH_SYSTEM,
      `Original task:\n${task}\n\nSubagent results:\n${evidence}`,
    )
  } catch (err) {
    synthesis = results.map((r) => r.output).join("\n\n---\n\n")
    return {
      task,
      mode: "decomposed",
      subtasks: capped,
      results,
      synthesis,
      error: `synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  return { task, mode: "decomposed", subtasks: capped, results, synthesis }
}
