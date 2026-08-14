/**
 * Refine proposal generator — evidence-driven self-improvement.
 *
 * Reads recent session trajectories and asks the model to act as an
 * improvement reviewer, producing structured, *reviewable* proposals:
 *
 *   - `tactic`       → a new KEP tactic draft for the experience loop
 *   - `prompt_patch` → a markdown patch for the persistent prompt file
 *
 * Proposals are written to disk as `pending`; a human must approve them
 * (`momo /refine approve <id>`) before anything takes effect.
 *
 * @module refine/propose
 */

import { chatComplete, resolveProviderConfig } from "../cli/chat.js"
import { readRecentSessions, type SessionRecord } from "../session/recorder.js"
import {
  generateProposalId,
  saveProposal,
  type RefineProposal,
  type TacticProposalBody,
} from "./store.js"

// ---------------------------------------------------------------------------
// Reviewer prompt
// ---------------------------------------------------------------------------

const REVIEWER_SYSTEM = `You are an improvement reviewer for an AI coding agent.
You review the agent's recent session trajectories and propose small,
evidence-based, REVERSIBLE improvements to its behavior.

You may propose two kinds of changes:
1. "tactic" — a reusable strategy card (trigger conditions, steps, checks)
   that will be injected into the agent's prompt when relevant.
2. "prompt_patch" — a short markdown snippet appended to the agent's
   persistent prompt (style preferences, recurring cautions, conventions).

Rules:
- Every proposal MUST cite the session ids it is based on (evidence).
- Keep proposals small and specific. No generic advice.
- checks may only use commands starting with: node, npm, pnpm, npx, tsc, eslint.
- If the trajectories show nothing worth improving, return an empty list.

Respond with ONLY a JSON object of this exact shape (no prose, no fences):
{
  "proposals": [
    {
      "type": "tactic",
      "title": "one-line summary",
      "intent": "convention | fix | optimize | workflow",
      "rationale": "why this helps, citing observed behavior",
      "evidence": ["ses_..."],
      "preconditions": ["..."],
      "steps": ["..."],
      "checks": ["npm test"]
    },
    {
      "type": "prompt_patch",
      "title": "one-line summary",
      "rationale": "why this helps",
      "evidence": ["ses_..."],
      "patch": "markdown text to append"
    }
  ]
}`

// ---------------------------------------------------------------------------
// Trajectory formatting
// ---------------------------------------------------------------------------

function formatTrajectories(records: SessionRecord[]): string {
  return records
    .map((r) => {
      const outcome = r.exitCode === 0 ? "ok" : `error(exit=${r.exitCode})`
      const response =
        r.response.length > 1200 ? r.response.slice(0, 1200) + "…" : r.response
      return [
        `--- session ${r.id} (${r.ts}, ${r.model}, ${outcome}) ---`,
        `PROMPT: ${r.prompt}`,
        `RESPONSE: ${response}`,
      ].join("\n")
    })
    .join("\n\n")
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface RawProposal {
  type?: string
  title?: string
  intent?: string
  rationale?: string
  evidence?: string[]
  preconditions?: string[]
  steps?: string[]
  checks?: string[]
  patch?: string
}

/** Extract the first balanced JSON object from model output. */
export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf("{")
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === "\\" && inString) {
      escape = true
      continue
    }
    if (ch === '"') inString = !inString
    if (inString) continue
    if (ch === "{") depth++
    if (ch === "}") {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

const VALID_INTENTS = new Set(["convention", "fix", "optimize", "workflow"])

/** Validate and normalize raw model output into RefineProposal objects. */
export function normalizeProposals(raw: unknown): RefineProposal[] {
  if (!raw || typeof raw !== "object") return []
  const list = (raw as { proposals?: unknown }).proposals
  if (!Array.isArray(list)) return []

  const out: RefineProposal[] = []
  for (const item of list as RawProposal[]) {
    if (!item || typeof item !== "object") continue
    const title = typeof item.title === "string" ? item.title.trim() : ""
    const rationale =
      typeof item.rationale === "string" ? item.rationale.trim() : ""
    if (!title || !rationale) continue

    const evidence = Array.isArray(item.evidence)
      ? item.evidence.filter((e): e is string => typeof e === "string")
      : []
    if (evidence.length === 0) continue // evidence is mandatory

    const base = {
      id: generateProposalId(title),
      ts: new Date().toISOString(),
      status: "pending" as const,
      evidence,
      rationale,
      title,
    }

    if (item.type === "tactic") {
      const steps = Array.isArray(item.steps)
        ? item.steps.filter(
            (s): s is string => typeof s === "string" && s.trim().length > 0,
          )
        : []
      if (steps.length === 0) continue
      const tactic: TacticProposalBody = {
        title,
        intent: VALID_INTENTS.has(item.intent || "")
          ? (item.intent as TacticProposalBody["intent"])
          : "workflow",
        preconditions: Array.isArray(item.preconditions)
          ? item.preconditions.filter(
              (s): s is string => typeof s === "string" && s.trim().length > 0,
            )
          : [],
        steps,
        checks: Array.isArray(item.checks)
          ? item.checks.filter(
              (s): s is string => typeof s === "string" && s.trim().length > 0,
            )
          : [],
      }
      out.push({ ...base, type: "tactic", tactic })
    } else if (item.type === "prompt_patch") {
      const patch = typeof item.patch === "string" ? item.patch.trim() : ""
      if (!patch) continue
      out.push({ ...base, type: "prompt_patch", patch })
    }
  }
  return out.slice(0, 5) // at most 5 proposals per run
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export interface ProposeResult {
  readonly proposals: RefineProposal[]
  readonly sessionsReviewed: number
  readonly error?: string
}

/**
 * Generate refinement proposals from the most recent `last` session records.
 * Persists valid proposals as `pending` and returns them.
 */
export async function generateProposals(last: number): Promise<ProposeResult> {
  const sessions = readRecentSessions(last)
  if (sessions.length === 0) {
    return { proposals: [], sessionsReviewed: 0, error: "no sessions recorded yet" }
  }

  const config = await resolveProviderConfig()
  if (!config || !config.baseUrl) {
    return {
      proposals: [],
      sessionsReviewed: sessions.length,
      error: "no provider configured (set MOMO_API_KEY)",
    }
  }

  let responseText: string
  try {
    responseText = await chatComplete({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      system: REVIEWER_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Review these ${sessions.length} recent session trajectories and propose improvements:\n\n${formatTrajectories(sessions)}`,
        },
      ],
      stream: false,
      temperature: 0.3,
    })
  } catch (err) {
    return {
      proposals: [],
      sessionsReviewed: sessions.length,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  const proposals = normalizeProposals(extractJsonObject(responseText))
  for (const p of proposals) saveProposal(p)
  return { proposals, sessionsReviewed: sessions.length }
}
