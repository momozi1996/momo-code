/**
 * Optim runner — the reasoning-driven optimization loop.
 *
 * Per trial:
 *   1. warmup (first n_init trials) → RandomSampler; afterwards the agent
 *      proposes with explicit reasoning + a qualitative note.
 *   2. The evaluator measures the configuration (cmd or sim mode).
 *   3. The trial (params, value, _reasoning, _note) is appended to
 *      trials.jsonl — the full reasoning trace persists across sessions,
 *      so a study resumes exactly where it stopped.
 *
 * A failed evaluation marks the trial `failed` (it still enters the
 * history — the agent learns from it); only a broken study config aborts.
 *
 * @module optim/runner
 */

import { SimBridge } from "../sim/bridge.js"
import { evaluate, type EvalContext } from "./evaluate.js"
import { AgentSampler, RandomSampler, type Sampler } from "./sampler.js"
import type { SemanticsMap } from "./semantics.js"
import {
  appendTrial,
  bestTrial,
  nextTrialNumber,
  readTrials,
  type StudyConfig,
  type TrialRecord,
} from "./study.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunOpts {
  /** Total NEW trials to run (resumed studies continue numbering) */
  readonly trials: number
  /** Sampler for post-warmup trials (default AgentSampler) */
  readonly sampler?: Sampler
  /** Random warmup trials before the agent is consulted
   *  (default MOMO_OPTIM_N_INIT or 2) */
  readonly nInit?: number
  /** Approved semantic map; undefined = blind optimization */
  readonly semantics?: SemanticsMap
  /** Called after every trial (live progress output) */
  readonly onTrial?: (record: TrialRecord) => void
  /** sim evaluator options forwarded to SimBridge.initWorld */
  readonly simInit?: { viewer?: boolean; backend?: string }
}

export interface RunResult {
  readonly ran: number
  readonly best: TrialRecord | null
  readonly trials: readonly TrialRecord[]
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export async function runStudy(config: StudyConfig, opts: RunOpts): Promise<RunResult> {
  const nInit = opts.nInit ?? (Number(process.env.MOMO_OPTIM_N_INIT) || 2)
  const agent = opts.sampler ?? new AgentSampler()
  const warmup = new RandomSampler()

  // sim evaluator: one persistent world for the whole run
  let bridge: SimBridge | undefined
  const evalCtx: EvalContext = {}
  if (config.evaluator.kind === "sim") {
    bridge = new SimBridge()
    await bridge.initWorld({
      viewer: opts.simInit?.viewer ?? false,
      backend: opts.simInit?.backend,
    })
    evalCtx.bridge = bridge
  }

  try {
    let ran = 0
    while (ran < opts.trials) {
      const history = readTrials(config.name)
      const number = nextTrialNumber(history)
      const input = { config, trials: history, semantics: opts.semantics }

      const proposal =
        number < nInit ? await warmup.propose(input) : await agent.propose(input)

      const startMs = Date.now()
      let record: TrialRecord
      try {
        const { value } = await evaluate(config.evaluator, config.metric, proposal.params, evalCtx)
        record = {
          number,
          params: proposal.params,
          state: "complete",
          ts: new Date().toISOString(),
          value,
          durationMs: Date.now() - startMs,
          ...(proposal.reasoning ? { reasoning: proposal.reasoning } : {}),
          ...(proposal.note ? { note: proposal.note } : {}),
          ...(proposal.fallback ? { fallback: true } : {}),
        }
      } catch (err) {
        // Evaluation failure still enters history — the agent learns from it.
        record = {
          number,
          params: proposal.params,
          state: "failed",
          ts: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          error: err instanceof Error ? err.message : String(err),
          ...(proposal.fallback ? { fallback: true } : {}),
        }
      }

      appendTrial(config.name, record)
      opts.onTrial?.(record)
      ran++
    }
  } finally {
    if (bridge) await bridge.close()
  }

  const trials = readTrials(config.name)
  return { ran: opts.trials, best: bestTrial(config.direction, trials), trials }
}
