/**
 * Optim semantics — the code-reading layer that turns blind optimization
 * into reasoning-driven optimization.
 *
 * The agent reads the target source code and produces a *semantic map*:
 * for every parameter — its physical meaning, unit, business role, and
 * plausible range; plus cross-parameter interactions and the constraints
 * the evaluator/business logic imposes. This map is the highest-leverage
 * prompt knob (optim-agent's `context`, generalized to skill mode: the
 * agent reads the project first).
 *
 * Nothing is fed to the sampler without an explicit human `approve`
 * (mirrors the /refine review gate). Without an approved map the study
 * still runs — as a blind optimizer, with the prompt clearly marked as
 * degraded.
 *
 * Storage (inside the study dir):
 *   semantics.json  — machine-readable map + status machine draft→approved
 *   SEMANTICS.md    — human-readable rendering (review/edit, then approve)
 *
 * @module optim/semantics
 */

import * as fs from "fs"
import * as path from "path"
import { chatComplete, resolveProviderConfig } from "../cli/chat.js"
import { extractJsonObject } from "../refine/propose.js"
import { getStudyDir, type ParamSpec } from "./study.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParamSemantics {
  /** Physical meaning / business role, e.g. "decision threshold; higher
   *  values trade recall for precision" */
  readonly context: string
  /** Physical unit if any (e.g. "rad/s", "USD/request") */
  readonly unit?: string
}

export interface SemanticsMap {
  /** Source path the map was derived from */
  readonly target: string
  status: "draft" | "approved"
  readonly params: Record<string, ParamSemantics>
  /** How parameters influence each other */
  readonly interactions?: string
  /** What the evaluator / business logic constrains */
  readonly constraints?: string
  readonly createdAt: string
  approvedAt?: string
}

// ---------------------------------------------------------------------------
// Paths & persistence (atomic writes)
// ---------------------------------------------------------------------------

export function semanticsFile(studyName: string): string {
  return path.join(getStudyDir(studyName), "semantics.json")
}

export function semanticsMarkdownFile(studyName: string): string {
  return path.join(getStudyDir(studyName), "SEMANTICS.md")
}

export function saveSemantics(studyName: string, map: SemanticsMap): void {
  const file = semanticsFile(studyName)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), "utf-8")
  fs.renameSync(tmp, file)
  fs.writeFileSync(semanticsMarkdownFile(studyName), renderSemanticsMarkdown(map), "utf-8")
}

export function loadSemantics(studyName: string): SemanticsMap | null {
  try {
    const file = semanticsFile(studyName)
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, "utf-8")) as SemanticsMap
  } catch {
    return null
  }
}

/** Approve a draft map (human review gate). Returns null if missing. */
export function approveSemantics(studyName: string): SemanticsMap | null {
  const map = loadSemantics(studyName)
  if (!map) return null
  map.status = "approved"
  map.approvedAt = new Date().toISOString()
  saveSemantics(studyName, map)
  return map
}

// ---------------------------------------------------------------------------
// Normalize & render (pure — unit-tested)
// ---------------------------------------------------------------------------

/**
 * Validate/normalize a raw LLM-produced semantic map against the space.
 * Parameters missing from the reply get a name-based placeholder context;
 * unknown parameters are dropped. Always returns a usable draft.
 */
export function normalizeSemantics(
  raw: unknown,
  target: string,
  space: readonly ParamSpec[],
): SemanticsMap {
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
  const rawParams = (typeof obj.params === "object" && obj.params !== null
    ? obj.params
    : {}) as Record<string, unknown>

  const params: Record<string, ParamSemantics> = {}
  for (const p of space) {
    const rp = rawParams[p.name]
    if (typeof rp === "object" && rp !== null && typeof (rp as any).context === "string") {
      const r = rp as { context: string; unit?: unknown }
      params[p.name] = {
        context: r.context,
        ...(typeof r.unit === "string" ? { unit: r.unit } : {}),
      }
    } else if (typeof rp === "string") {
      params[p.name] = { context: rp }
    } else {
      params[p.name] = { context: `${p.name} (semantics not inferred — treat as opaque)` }
    }
  }

  return {
    target,
    status: "draft",
    params,
    ...(typeof obj.interactions === "string" ? { interactions: obj.interactions } : {}),
    ...(typeof obj.constraints === "string" ? { constraints: obj.constraints } : {}),
    createdAt: new Date().toISOString(),
  }
}

export function renderSemanticsMarkdown(map: SemanticsMap): string {
  const lines: string[] = [
    `# Parameter Semantics — ${map.target}`,
    ``,
    `Status: **${map.status}** · created ${map.createdAt}${map.approvedAt ? ` · approved ${map.approvedAt}` : ""}`,
    ``,
    `| Parameter | Meaning | Unit |`,
    `|---|---|---|`,
  ]
  for (const [name, sem] of Object.entries(map.params)) {
    lines.push(`| \`${name}\` | ${sem.context} | ${sem.unit ?? "—"} |`)
  }
  if (map.interactions) lines.push(``, `## Interactions`, ``, map.interactions)
  if (map.constraints) lines.push(``, `## Constraints`, ``, map.constraints)
  lines.push(``)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Code reading → semantic map (one-shot LLM call)
// ---------------------------------------------------------------------------

const MAX_CODE_CHARS = 12000

const SCAN_SYSTEM = `You are a code-reading analyst. Given source code and a
list of tunable parameters, infer for each parameter its PHYSICAL MEANING
and BUSINESS ROLE: what it controls in the real system, its unit if any,
and how it trades off (e.g. "higher values trade recall for precision").
Also infer how the parameters interact with each other, and what the
evaluator / business logic constrains (cost budgets, safety limits, SLAs).

Reply with ONLY a JSON object (no prose, no fences):
{
  "params": {"<name>": {"context": "...", "unit": "..."}, ...},
  "interactions": "how the parameters influence each other",
  "constraints": "what the evaluator / business logic constrains"
}`

export interface ScanResult {
  readonly map: SemanticsMap
  readonly files: string[]
}

/**
 * Read the target code and infer a semantic map for the given space.
 * Throws when no provider is configured or the reply is unusable.
 */
export async function generateSemantics(
  target: string,
  space: readonly ParamSpec[],
): Promise<ScanResult> {
  const provider = await resolveProviderConfig()
  if (!provider) {
    throw new Error(
      `No provider configured — cannot read code. ` +
        `Set MOMO_API_KEY (or configure CC Switch) and retry.`,
    )
  }

  const resolved = path.resolve(target)
  if (!fs.existsSync(resolved)) throw new Error(`Target not found: ${resolved}`)

  // Collect source: single file, or all text files in a directory (capped).
  const files: string[] = []
  const chunks: string[] = []
  let budget = MAX_CODE_CHARS
  const addFile = (f: string) => {
    if (budget <= 0) return
    try {
      const content = fs.readFileSync(f, "utf-8")
      const slice = content.slice(0, budget)
      chunks.push(`### ${path.basename(f)}\n${slice}`)
      files.push(f)
      budget -= slice.length
    } catch {
      // unreadable file — skip
    }
  }
  const stat = fs.statSync(resolved)
  if (stat.isDirectory()) {
    for (const f of fs.readdirSync(resolved).sort()) {
      if (/\.(ts|js|py|json|yaml|yml|toml|md)$/i.test(f)) addFile(path.join(resolved, f))
    }
  } else {
    addFile(resolved)
  }
  if (chunks.length === 0) throw new Error(`No readable source files under ${resolved}`)

  const spaceDesc = space
    .map((p) =>
      p.type === "categorical"
        ? `- ${p.name}: categorical {${p.choices!.join(", ")}}`
        : `- ${p.name}: ${p.type} in [${p.low}, ${p.high}]${p.log ? " (log)" : ""}`,
    )
    .join("\n")

  const userMsg =
    `Parameters to explain:\n${spaceDesc}\n\n` +
    `Source code:\n\n${chunks.join("\n\n")}`

  const reply = await chatComplete({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    system: SCAN_SYSTEM,
    messages: [{ role: "user", content: userMsg }],
    stream: false,
    temperature: 0.2,
    timeout: 180_000,
  })

  const raw = extractJsonObject(reply)
  if (!raw) throw new Error(`Could not parse a semantic map from the model reply`)
  return { map: normalizeSemantics(raw, target, space), files }
}
