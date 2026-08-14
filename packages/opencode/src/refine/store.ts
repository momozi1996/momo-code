/**
 * Refine proposal store — persistence for /refine self-improvement proposals.
 *
 * Proposals are stored as individual JSON files under
 * `~/.momo/refine/proposals/<id>.json` with a simple status machine:
 *
 *   pending → approved → applied
 *           → rejected
 *
 * Nothing is ever applied without an explicit human `approve` step
 * (mirrors the ratchet-gate philosophy of the fine-tune slow loop).
 *
 * @module refine/store
 */

import * as fs from "fs"
import * as path from "path"
import * as crypto from "crypto"
import { getMomoHome } from "../session/recorder.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProposalStatus = "pending" | "approved" | "rejected" | "applied"

export interface TacticProposalBody {
  readonly title: string
  readonly intent?: "convention" | "fix" | "optimize" | "workflow"
  readonly preconditions: string[]
  readonly steps: string[]
  readonly checks: string[]
}

export interface RefineProposal {
  /** Unique id: `prop_<hash>` */
  readonly id: string
  /** ISO-8601 creation timestamp */
  readonly ts: string
  readonly type: "tactic" | "prompt_patch"
  status: ProposalStatus
  /** Session record ids that motivated this proposal */
  readonly evidence: string[]
  /** Why the reviewer model believes this improves the agent */
  readonly rationale: string
  /** One-line summary */
  readonly title: string
  /** Present when type === "tactic" */
  readonly tactic?: TacticProposalBody
  /** Markdown patch appended to ~/.momo/prompts/refine-patch.md (type === "prompt_patch") */
  readonly patch?: string
  appliedAt?: string
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getRefineDir(): string {
  return path.join(getMomoHome(), "refine")
}

function getProposalsDir(): string {
  return path.join(getRefineDir(), "proposals")
}

function proposalPath(id: string): string {
  return path.join(getProposalsDir(), `${id}.json`)
}

export function generateProposalId(seed: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(`${seed}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 10)
  return `prop_${hash}`
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Persist a proposal (atomic tmp+rename write). */
export function saveProposal(p: RefineProposal): void {
  const dir = getProposalsDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = proposalPath(p.id)
  const tmp = `${file}.tmp.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2), "utf-8")
  fs.renameSync(tmp, file)
}

/** Load one proposal by id, or null if missing/corrupt. */
export function loadProposal(id: string): RefineProposal | null {
  try {
    const file = proposalPath(id)
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, "utf-8")) as RefineProposal
  } catch {
    return null
  }
}

/** List proposals, newest first. Optionally filter by status. */
export function listProposals(status?: ProposalStatus): RefineProposal[] {
  try {
    const dir = getProposalsDir()
    if (!fs.existsSync(dir)) return []
    const out: RefineProposal[] = []
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue
      try {
        const p = JSON.parse(
          fs.readFileSync(path.join(dir, f), "utf-8"),
        ) as RefineProposal
        if (!status || p.status === status) out.push(p)
      } catch {
        // skip corrupt files
      }
    }
    return out.sort((a, b) => b.ts.localeCompare(a.ts))
  } catch {
    return []
  }
}

/** Update a proposal's status (and appliedAt when applied). */
export function updateProposalStatus(
  id: string,
  status: ProposalStatus,
): RefineProposal | null {
  const p = loadProposal(id)
  if (!p) return null
  p.status = status
  if (status === "applied") p.appliedAt = new Date().toISOString()
  saveProposal(p)
  return p
}
