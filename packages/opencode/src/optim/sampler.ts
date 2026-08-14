/**
 * Optim samplers — who chooses the next configuration.
 *
 * Three implementations:
 *   - RandomSampler — uniform baseline; also the warmup (n_init) and the
 *     implicit fallback whenever the agent flakes.
 *   - MockSampler   — token-free offline stand-in (hill climbing with
 *     gaussian jitter around the best point). Deliberately not a good
 *     optimizer; exists so tests never touch an LLM.
 *   - AgentSampler  — the reasoning-driven core. Builds a harness prompt
 *     (direction + study context + parameter semantics + search space +
 *     recent trial table + best-so-far + the agent's previous qualitative
 *     note), asks for `{params, _reasoning, _note}`, validates/clamps the
 *     reply, retries once on garbage, then falls back to a random point
 *     with a warning — a flaky agent can never crash a study.
 *
 * @module optim/sampler
 */

import { chatComplete, resolveProviderConfig } from "../cli/chat.js"
import { extractJsonObject } from "../refine/propose.js"
import {
  bestTrial,
  lastNote,
  type ParamSpec,
  type ParamValue,
  type StudyConfig,
  type TrialRecord,
} from "./study.js"
import type { SemanticsMap } from "./semantics.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Proposal {
  readonly params: Record<string, ParamValue>
  /** Agent's explicit justification (reasoning-driven core) */
  readonly reasoning?: string
  /** Agent's qualitative landscape note — fed back on the next trial */
  readonly note?: string
  /** true when the point came from random fallback instead of the agent */
  readonly fallback: boolean
}

export interface SamplerInput {
  readonly config: StudyConfig
  readonly trials: readonly TrialRecord[]
  /** Approved parameter semantics; undefined = blind optimization */
  readonly semantics?: SemanticsMap
}

export interface Sampler {
  readonly name: string
  propose(input: SamplerInput): Promise<Proposal>
}

// ---------------------------------------------------------------------------
// RNG (seedable — tests and fallbacks must be reproducible)
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box-Muller gaussian from a uniform source. */
function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12)
  const v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// ---------------------------------------------------------------------------
// Sampling & validation (pure — unit-tested)
// ---------------------------------------------------------------------------

/** Draw one uniform random point from the space. */
export function sampleRandomPoint(
  space: readonly ParamSpec[],
  rand: () => number,
): Record<string, ParamValue> {
  const params: Record<string, ParamValue> = {}
  for (const p of space) {
    if (p.type === "categorical") {
      params[p.name] = p.choices![Math.floor(rand() * p.choices!.length)]
    } else if (p.log) {
      const v = Math.exp(Math.log(p.low!) + rand() * (Math.log(p.high!) - Math.log(p.low!)))
      params[p.name] = p.type === "int" ? Math.round(v) : v
    } else {
      const v = p.low! + rand() * (p.high! - p.low!)
      params[p.name] = p.type === "int" ? Math.round(v) : v
    }
  }
  return params
}

/**
 * Validate and canonicalize raw agent params against the space:
 * numeric values are clamped into range, ints rounded, categoricals must
 * match a declared choice, NaN/Infinity rejected, missing params rejected.
 * Throws on anything unrecoverable.
 */
export function validateParams(
  raw: unknown,
  space: readonly ParamSpec[],
): Record<string, ParamValue> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("params must be a JSON object")
  }
  const obj = raw as Record<string, unknown>
  const out: Record<string, ParamValue> = {}
  for (const p of space) {
    const v = obj[p.name]
    if (v === undefined) throw new Error(`missing parameter "${p.name}"`)
    if (p.type === "categorical") {
      const s = String(v)
      if (!p.choices!.includes(s)) {
        throw new Error(`parameter "${p.name}" must be one of ${p.choices!.join("|")}, got "${s}"`)
      }
      out[p.name] = s
    } else {
      const n = typeof v === "string" ? Number(v) : (v as number)
      if (typeof n !== "number" || !Number.isFinite(n)) {
        throw new Error(`parameter "${p.name}" must be a finite number, got ${JSON.stringify(v)}`)
      }
      const clamped = Math.min(p.high!, Math.max(p.low!, n))
      out[p.name] = p.type === "int" ? Math.round(clamped) : clamped
    }
  }
  return out
}

/** Parse an agent reply into a validated proposal. Throws on garbage. */
export function extractProposal(
  reply: string,
  space: readonly ParamSpec[],
): { params: Record<string, ParamValue>; reasoning?: string; note?: string } {
  const obj = extractJsonObject(reply) as Record<string, unknown> | null
  if (!obj) throw new Error("no JSON object found in the agent reply")
  const params = validateParams(obj.params, space)
  return {
    params,
    ...(typeof obj._reasoning === "string" ? { reasoning: obj._reasoning } : {}),
    ...(typeof obj._note === "string" ? { note: obj._note } : {}),
  }
}

// ---------------------------------------------------------------------------
// RandomSampler
// ---------------------------------------------------------------------------

export class RandomSampler implements Sampler {
  readonly name = "random"
  private readonly rand: () => number

  constructor(seed?: number) {
    this.rand = mulberry32(seed ?? Date.now())
  }

  async propose(input: SamplerInput): Promise<Proposal> {
    return {
      params: sampleRandomPoint(input.config.space, this.rand),
      fallback: true,
    }
  }
}

// ---------------------------------------------------------------------------
// MockSampler — offline hill climbing with gaussian jitter (tests only)
// ---------------------------------------------------------------------------

export class MockSampler implements Sampler {
  readonly name = "mock"
  private readonly rand: () => number

  constructor(seed?: number) {
    this.rand = mulberry32(seed ?? 42)
  }

  async propose(input: SamplerInput): Promise<Proposal> {
    const best = bestTrial(input.config.direction, input.trials)
    if (!best) {
      return { params: sampleRandomPoint(input.config.space, this.rand), fallback: true }
    }
    const params: Record<string, ParamValue> = {}
    for (const p of input.config.space) {
      if (p.type === "categorical") {
        params[p.name] =
          this.rand() < 0.8
            ? (best.params[p.name] as string)
            : p.choices![Math.floor(this.rand() * p.choices!.length)]
      } else {
        const span = p.high! - p.low!
        const jittered = (best.params[p.name] as number) + gaussian(this.rand) * span * 0.1
        const clamped = Math.min(p.high!, Math.max(p.low!, jittered))
        params[p.name] = p.type === "int" ? Math.round(clamped) : clamped
      }
    }
    return { params, reasoning: "mock: jitter around best", fallback: false }
  }
}

// ---------------------------------------------------------------------------
// AgentSampler — reasoning-driven proposals
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an optimization sampler for a black-box system.
You will be shown: the optimization direction, what is being tuned, the
physical/business meaning of each parameter, the search-space bounds, a
table of past trials (including failures), the best result so far, and your
own previous notes.

Reason explicitly about parameter semantics and interactions before choosing
numbers — "lr=0.1 diverged" is a fact you know how to respond to, not just a
bad data point. Balance exploration and exploitation.

Reply with ONLY a JSON object (no prose, no fences):
{
  "params": {"<name>": <value>, ...},   // every declared parameter, in bounds
  "_reasoning": "why this point — reference evidence from the trial table",
  "_note": "qualitative observation about the landscape worth remembering"
}`

function formatParamBlock(p: ParamSpec, semantics?: SemanticsMap): string {
  const sem = semantics?.params[p.name]
  const range =
    p.type === "categorical"
      ? `one of {${p.choices!.join(", ")}}`
      : `[${p.low}, ${p.high}]${p.log ? " (log scale)" : ""}${p.type === "int" ? " (integer)" : ""}`
  const meaning = sem ? ` — ${sem.context}` : ""
  return `- ${p.name}: ${p.type}, ${range}${meaning}`
}

export function buildHarnessPrompt(input: SamplerInput, history: number): string {
  const { config, trials, semantics } = input
  const lines: string[] = []

  lines.push(`Direction: ${config.direction} the metric "${config.metric}"`)
  if (config.context) lines.push(`\nWhat is being tuned:\n${config.context}`)

  lines.push(`\nSearch space:`)
  for (const p of config.space) lines.push(formatParamBlock(p, semantics))

  if (semantics) {
    if (semantics.interactions) lines.push(`\nParameter interactions:\n${semantics.interactions}`)
    if (semantics.constraints) lines.push(`\nEvaluator/business constraints:\n${semantics.constraints}`)
  } else {
    lines.push(
      `\n(No semantic map approved for this study — optimizing blind. ` +
        `Infer what you can from parameter names and history.)`,
    )
  }

  const recent = trials.slice(-history)
  if (recent.length > 0) {
    lines.push(`\nTrial history (last ${recent.length}):`)
    for (const t of recent) {
      const ps = Object.entries(t.params)
        .map(([k, v]) => `${k}=${typeof v === "number" ? Number(v.toPrecision(6)) : v}`)
        .join(", ")
      const val = t.value !== undefined ? ` value=${Number(t.value.toPrecision(6))}` : ""
      const fb = t.fallback ? " [random]" : ""
      lines.push(`  #${t.number} ${t.state}${val}${fb} | ${ps}`)
      if (t.reasoning) lines.push(`      reasoning: ${t.reasoning}`)
    }
  }

  const best = bestTrial(config.direction, trials)
  if (best && best.value !== undefined) {
    const ps = Object.entries(best.params)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")
    lines.push(`\nBest so far: value=${best.value} at {${ps}} (trial #${best.number})`)
  }

  const note = lastNote(trials)
  if (note) lines.push(`\nYour previous note: ${note}`)

  lines.push(`\nPropose the next configuration.`)
  return lines.join("\n")
}

export interface AgentSamplerOpts {
  /** trials shown to the agent (default MOMO_OPTIM_HISTORY or 5) */
  readonly history?: number
  /** per-call timeout seconds (default MOMO_OPTIM_TIMEOUT or 300) */
  readonly timeoutSec?: number
  readonly seed?: number
}

export class AgentSampler implements Sampler {
  readonly name = "agent"
  private readonly history: number
  private readonly timeoutMs: number
  private readonly fallback: RandomSampler

  constructor(opts: AgentSamplerOpts = {}) {
    this.history =
      opts.history ?? (Number(process.env.MOMO_OPTIM_HISTORY) || 5)
    this.timeoutMs =
      (opts.timeoutSec ?? (Number(process.env.MOMO_OPTIM_TIMEOUT) || 300)) * 1000
    this.fallback = new RandomSampler(opts.seed)
  }

  async propose(input: SamplerInput): Promise<Proposal> {
    const provider = await resolveProviderConfig()
    if (!provider) {
      console.warn(`[optim] no provider configured — falling back to random sampling`)
      return this.fallback.propose(input)
    }

    const prompt = buildHarnessPrompt(input, this.history)
    const call = (userMsg: string) =>
      chatComplete({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: provider.model,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMsg }],
        stream: false,
        temperature: 0.4,
        timeout: this.timeoutMs,
      })

    try {
      const reply = await call(prompt)
      try {
        const parsed = extractProposal(reply, input.config.space)
        return { ...parsed, fallback: false }
      } catch (firstErr) {
        // One retry with corrective feedback, then random fallback.
        const correction =
          `${prompt}\n\nYour previous reply was rejected: ` +
          `${firstErr instanceof Error ? firstErr.message : firstErr}. ` +
          `Reply with ONLY the corrected JSON object.`
        const retry = await call(correction)
        const parsed = extractProposal(retry, input.config.space)
        return { ...parsed, fallback: false }
      }
    } catch (err) {
      console.warn(
        `[optim] agent proposal failed (${err instanceof Error ? err.message : err}) — ` +
          `falling back to random sampling for this trial`,
      )
      return this.fallback.propose(input)
    }
  }
}
