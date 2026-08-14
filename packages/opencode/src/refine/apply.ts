/**
 * Refine proposal application — turn approved proposals into live assets.
 *
 * - `tactic` proposals become **draft** tactics in the experience store
 *   (they still have to earn promotion through the existing Gate).
 * - `prompt_patch` proposals are appended to
 *   `~/.momo/prompts/refine-patch.md`, which chat.ts injects into the
 *   system prompt on every run.
 *
 * Only proposals with status `approved` can be applied.
 *
 * @module refine/apply
 */

import * as fs from "fs"
import * as path from "path"
import { Effect } from "effect"
import { generateTacticId, type Tactic } from "../experience/tactic.js"
import { ExperienceStore, ExperienceStoreLive } from "../experience/store.js"
import {
  ALLOWED_CHECK_PREFIXES,
  BANNED_SHELL_PATTERNS,
} from "../experience/guard.js"
import { getMomoHome } from "../session/recorder.js"
import {
  loadProposal,
  updateProposalStatus,
  type RefineProposal,
} from "./store.js"

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate tactic checks against the experience guard's command whitelist.
 * Returns an error message, or null when valid.
 */
export function validateChecks(checks: ReadonlyArray<string>): string | null {
  for (const cmd of checks) {
    const trimmed = cmd.trim()
    if (!trimmed) continue
    const firstToken = trimmed.split(/\s+/)[0]
    const allowed = ALLOWED_CHECK_PREFIXES.some(
      (prefix) => firstToken === prefix || firstToken.startsWith(prefix),
    )
    if (!allowed) {
      return `check command '${firstToken}' not in whitelist: ${ALLOWED_CHECK_PREFIXES.join(", ")}`
    }
    for (const pattern of BANNED_SHELL_PATTERNS) {
      if (pattern.test(trimmed)) {
        return `check command contains banned shell pattern: ${pattern.source}`
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Tactic construction
// ---------------------------------------------------------------------------

function buildTactic(p: RefineProposal): Tactic | null {
  const body = p.tactic
  if (!body || body.steps.length === 0) return null
  const now = new Date().toISOString()
  return {
    id: generateTacticId("global", body.title),
    scope: "global",
    intent: body.intent ?? "workflow",
    title: body.title,
    // Match the synthetic session-start signal emitted by chat.ts
    // (`test-pass` @ 0.95 confidence), so refined tactics are always
    // eligible for Thompson-ranked selection on any prompt.
    triggers: [{ types: ["test-pass"], minConfidence: 0.5 }],
    preconditions: body.preconditions.length
      ? [...body.preconditions]
      : ["Applicable to current task context"],
    steps: [...body.steps],
    guardrails: {
      maxFiles: 5,
      forbiddenPaths: [".git", "node_modules"],
      smallestReversible: true,
    },
    checks: [...body.checks],
    stats: {
      wins: 0,
      losses: 0,
      alpha: 1,
      beta: 1,
      lastUsed: now,
      uses: 0,
    },
    status: "draft",
    provenance: {
      fromSessions: [...p.evidence],
      createdAt: now,
      scrubbed: true,
    },
  }
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export interface ApplyResult {
  readonly ok: boolean
  readonly message: string
}

/** Path of the persistent prompt patch file. */
export function getPromptPatchPath(): string {
  return path.join(getMomoHome(), "prompts", "refine-patch.md")
}

/**
 * Apply an approved proposal. Human approval is enforced here:
 * proposals that are not `approved` are refused.
 */
export async function applyProposal(id: string): Promise<ApplyResult> {
  const p = loadProposal(id)
  if (!p) return { ok: false, message: `proposal not found: ${id}` }
  if (p.status === "applied") {
    return { ok: false, message: `proposal ${id} already applied` }
  }
  if (p.status !== "approved") {
    return {
      ok: false,
      message: `proposal ${id} is '${p.status}' — approve it first (momo /refine approve ${id})`,
    }
  }

  if (p.type === "tactic") {
    const checkError = validateChecks(p.tactic?.checks ?? [])
    if (checkError) return { ok: false, message: `guard rejected: ${checkError}` }

    const tactic = buildTactic(p)
    if (!tactic) return { ok: false, message: "invalid tactic proposal body" }

    try {
      const added = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ExperienceStore
          const existing = yield* store.loadTactics()
          if (existing.some((t) => t.id === tactic.id || t.title === tactic.title)) {
            return false
          }
          yield* store.saveTactics([...existing, tactic])
          yield* store.appendLedger({
            kind: "distill",
            tacticIds: [tactic.id],
            summary: `/refine applied proposal ${p.id}: ${tactic.title}`,
            timestamp: new Date().toISOString(),
          })
          return true
        }).pipe(Effect.provide(ExperienceStoreLive)),
      )
      if (!added) {
        return { ok: false, message: `tactic already exists (id ${tactic.id}) — skipped` }
      }
      updateProposalStatus(id, "applied")
      return { ok: true, message: `tactic '${tactic.title}' added as draft (id ${tactic.id})` }
    } catch (err) {
      return {
        ok: false,
        message: `failed to save tactic: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // prompt_patch
  const patch = p.patch?.trim()
  if (!patch) return { ok: false, message: "empty prompt patch" }
  try {
    const file = getPromptPatchPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const header = `\n\n## ${p.title}\n\n<!-- proposal ${p.id} · ${p.ts} · evidence: ${p.evidence.join(", ")} -->\n\n`
    fs.appendFileSync(file, header + patch + "\n", "utf-8")
    updateProposalStatus(id, "applied")
    return { ok: true, message: `prompt patch appended to ${file}` }
  } catch (err) {
    return {
      ok: false,
      message: `failed to write prompt patch: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
