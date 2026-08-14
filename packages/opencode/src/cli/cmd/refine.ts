/**
 * /refine command — evidence-driven self-improvement loop.
 *
 * Inspired by Prime Agent's /refine: review recent trajectories, propose
 * small reviewable patches, and only apply them after human approval.
 *
 * Sub-commands:
 *   momo /refine [--last=N] [--json]   Generate proposals from recent sessions
 *   momo /refine list [--status=S]     List proposals
 *   momo /refine show <id>             Show one proposal (evidence + content)
 *   momo /refine approve <id>          Approve a pending proposal
 *   momo /refine reject <id>           Reject a pending proposal
 *   momo /refine apply <id>            Apply an approved proposal
 */
import {
  listProposals,
  loadProposal,
  updateProposalStatus,
  type RefineProposal,
  type ProposalStatus,
} from "../../refine/store.js"
import { generateProposals } from "../../refine/propose.js"
import { applyProposal } from "../../refine/apply.js"

const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const YELLOW = "\x1b[33m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const MAGENTA = "\x1b[95m"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusColor(status: ProposalStatus): string {
  switch (status) {
    case "pending":
      return YELLOW
    case "approved":
      return CYAN
    case "applied":
      return GREEN
    case "rejected":
      return DIM
  }
}

function printProposalLine(p: RefineProposal): void {
  console.log(
    `  ${statusColor(p.status)}[${p.status}]${RESET} ${CYAN}${p.id}${RESET} ${p.title} ${DIM}(${p.type}, evidence: ${p.evidence.length})${RESET}`,
  )
}

function printProposalDetail(p: RefineProposal): void {
  console.log(`${MAGENTA}${p.id}${RESET} — ${p.title}`)
  console.log(`  type:      ${p.type}`)
  console.log(`  status:    ${statusColor(p.status)}${p.status}${RESET}`)
  console.log(`  created:   ${p.ts}`)
  console.log(`  evidence:  ${p.evidence.join(", ") || "(none)"}`)
  console.log(`  rationale: ${p.rationale}`)
  if (p.tactic) {
    console.log(`  intent:    ${p.tactic.intent ?? "workflow"}`)
    console.log(`  preconditions:`)
    for (const s of p.tactic.preconditions) console.log(`    - ${s}`)
    console.log(`  steps:`)
    for (const s of p.tactic.steps) console.log(`    - ${s}`)
    if (p.tactic.checks.length) {
      console.log(`  checks:`)
      for (const s of p.tactic.checks) console.log(`    - ${s}`)
    }
  }
  if (p.patch) {
    console.log(`  patch:`)
    for (const line of p.patch.split("\n")) console.log(`    ${line}`)
  }
  if (p.appliedAt) console.log(`  applied:   ${p.appliedAt}`)
}

function printUsage(): void {
  console.log(`${MAGENTA}momo /refine${RESET} — evidence-driven self-improvement`)
  console.log(``)
  console.log(`Usage:`)
  console.log(`  momo /refine [--last=N] [--json]   Generate proposals from recent sessions`)
  console.log(`  momo /refine list [--status=S]     List proposals`)
  console.log(`  momo /refine show <id>             Show one proposal`)
  console.log(`  momo /refine approve <id>          Approve a pending proposal`)
  console.log(`  momo /refine reject <id>           Reject a pending proposal`)
  console.log(`  momo /refine apply <id>            Apply an approved proposal`)
  console.log(``)
  console.log(`Proposals never take effect without 'approve' + 'apply'.`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runRefineCommand(args: string[]): Promise<void> {
  const sub = args[0]

  // ---- flags ---------------------------------------------------------------
  let last = 20
  let json = false
  let statusFilter: ProposalStatus | undefined
  for (const a of args) {
    if (a.startsWith("--last=")) last = Number(a.slice(7)) || 20
    else if (a === "--json") json = true
    else if (a.startsWith("--status=")) {
      const s = a.slice(9)
      if (["pending", "approved", "rejected", "applied"].includes(s)) {
        statusFilter = s as ProposalStatus
      }
    }
  }

  // ---- list ----------------------------------------------------------------
  if (sub === "list") {
    const proposals = listProposals(statusFilter)
    if (json) {
      console.log(JSON.stringify(proposals, null, 2))
      return
    }
    if (proposals.length === 0) {
      console.log(`${DIM}No proposals found. Run: momo /refine${RESET}`)
      return
    }
    console.log(`${MAGENTA}Refine proposals${RESET} (${proposals.length}):`)
    for (const p of proposals) printProposalLine(p)
    return
  }

  // ---- show ----------------------------------------------------------------
  if (sub === "show") {
    const p = args[1] ? loadProposal(args[1]) : null
    if (!p) {
      console.error(`Proposal not found: ${args[1] ?? "(missing id)"}`)
      process.exit(1)
    }
    if (json) console.log(JSON.stringify(p, null, 2))
    else printProposalDetail(p)
    return
  }

  // ---- approve / reject ----------------------------------------------------
  if (sub === "approve" || sub === "reject") {
    const id = args[1]
    if (!id) {
      console.error(`Usage: momo /refine ${sub} <id>`)
      process.exit(1)
    }
    const p = loadProposal(id)
    if (!p) {
      console.error(`Proposal not found: ${id}`)
      process.exit(1)
    }
    if (p.status !== "pending") {
      console.error(`Proposal ${id} is '${p.status}' — only pending proposals can be ${sub}d.`)
      process.exit(1)
    }
    const next: ProposalStatus = sub === "approve" ? "approved" : "rejected"
    updateProposalStatus(id, next)
    console.log(`${GREEN}✓${RESET} Proposal ${CYAN}${id}${RESET} → ${next}`)
    if (next === "approved") {
      console.log(`${DIM}Apply it with: momo /refine apply ${id}${RESET}`)
    }
    return
  }

  // ---- apply ---------------------------------------------------------------
  if (sub === "apply") {
    const id = args[1]
    if (!id) {
      console.error(`Usage: momo /refine apply <id>`)
      process.exit(1)
    }
    const result = await applyProposal(id)
    if (result.ok) {
      console.log(`${GREEN}✓${RESET} ${result.message}`)
    } else {
      console.error(`${MAGENTA}✗${RESET} ${result.message}`)
      process.exit(1)
    }
    return
  }

  // ---- generate (default) --------------------------------------------------
  if (sub && !sub.startsWith("--")) {
    console.error(`Unknown /refine sub-command: ${sub}`)
    printUsage()
    process.exit(1)
  }
  if (args.includes("--help") || args.includes("-h")) {
    printUsage()
    return
  }

  console.error(
    `${DIM}→ reviewing last ${last} session(s)…${RESET}`,
  )
  const result = await generateProposals(last)

  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (result.error) {
    console.error(`${MAGENTA}/refine${RESET}: ${result.error}`)
    process.exit(1)
  }
  if (result.proposals.length === 0) {
    console.log(
      `${DIM}Reviewed ${result.sessionsReviewed} session(s) — no improvements proposed.${RESET}`,
    )
    return
  }
  console.log(
    `${GREEN}✓${RESET} ${result.proposals.length} proposal(s) from ${result.sessionsReviewed} session(s):`,
  )
  for (const p of result.proposals) printProposalLine(p)
  console.log(``)
  console.log(`${DIM}Review:  momo /refine show <id>`)
  console.log(`Approve: momo /refine approve <id>  →  momo /refine apply <id>${RESET}`)
}
