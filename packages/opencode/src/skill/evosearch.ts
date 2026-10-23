/**
 * Evolutionary search over strategy candidates — port of ASPIRE's
 * evosearch protocol (evosearch-iteration.md).
 *
 * Each candidate is one complete strategy document (hypothesis frontmatter
 * + prose/ts body). A population of K structurally-different candidates is
 * authored, each is evaluated by independent worker subagents against the
 * task's check command, and the leaderboard (passRate, then fewest errors)
 * seeds the next iteration:
 *
 *   author K candidates → evaluate → leaderboard (iter<N>/leaderboard.json)
 *   → eliminate losers into a ledger → top-3 seed the next iteration
 *
 * Evaluation is fail-fast racing over up to `MOMO_ASPIRE_EVO_TRIALS`
 * attempts (default 3): every candidate runs once, a failure ends its run,
 * each pass buys one confirmation trial. Fitness is passes/attempts, so a
 * flaky pass can never reach the survivor pool or trigger "solved" — the
 * confirmation budget is spent only on candidates that actually passed.
 *
 * Discipline ported from ASPIRE: every candidate records Hypothesis /
 * differs_from_prior (a structural difference, not a parameter tweak) /
 * expected_failure_if_wrong / seeded_from. The eliminated ledger is handed
 * to the author, which may not re-test a ledger entry without a new
 * structural reason, and every iteration must include at least one
 * structurally novel candidate (seeded_from: "novel").
 *
 * Stop conditions (checked at the top of each loop): best passRate ≥
 * threshold → "solved"; iteration ≥ maxIterations → "max-iterations";
 * best improved < 5pp for 2 consecutive iterations → "plateau".
 *
 * @module skill/evosearch
 */

import * as fs from "fs"
import * as path from "path"
import { spawnSubagent, type SpawnOpts, type SubagentResult } from "../subagent/spawn"
import { chatComplete, resolveProviderConfig } from "../cli/chat"
import { extractJsonObject } from "../refine/propose"
import { getSkillCampaignsDir } from "./store"
import { assertCheckAllowed } from "./verifier"
import type { SpawnRunner } from "./coordinator"
import type { SkillTask } from "./schema"

// Re-export so CLI/tests depend on one import site.
export type { SpawnRunner }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StopReason = "solved" | "max-iterations" | "plateau"

/** One strategy candidate in the population. */
export interface EvoCandidate {
  name: string
  /** Path to the candidate markdown file (iter<N>/candidate_<X>.md). */
  codePath: string
  hypothesis: string
  /** "novel" or the survivor names this candidate was seeded from. */
  seededFrom: string
  status: "pending" | "evaluated" | "eliminated"
  /** passes / trials across the racing rounds (0..1). */
  passRate: number
  errors: number
  /** Attempts actually run (fails stop early: passRate*trials = passes). */
  trials: number
  failures: { stage: string; reason: string }[]
}

/** Contents of state.json — the whole searchable run. */
export interface EvoState {
  schemaVersion: 1
  dir: string
  task: SkillTask
  k: number
  iteration: number
  stopReason?: StopReason
  candidates: EvoCandidate[]
  /** Eliminated ledger — what was tried, why it died, when. */
  eliminated: Array<{ hypothesis: string; reason: string; iteration: number }>
}

/** One line of search progress for the CLI to print. */
export type EvoEvent =
  | { kind: "iteration-start"; iteration: number; k: number }
  | { kind: "candidate-authored"; iteration: number; name: string; seededFrom: string }
  | { kind: "candidate-attempt"; iteration: number; name: string; attempt: number; pass: boolean }
  | { kind: "candidate-evaluated"; iteration: number; name: string; pass: boolean; stage?: string; reason?: string }
  | { kind: "leaderboard"; iteration: number; best: string | null; bestPassRate: number }
  | { kind: "evosearch-done"; stopReason: StopReason; best: string | null; bestPassRate: number }

/** What the author is asked for; `author` is injectable (tests + custom policies). */
export interface AuthorRequest {
  task: SkillTask
  k: number
  iteration: number
  /** Top evaluated candidates across ALL iterations (seed material). */
  survivors: EvoCandidate[]
  /** The eliminated ledger (diversity-rule input). */
  eliminated: EvoState["eliminated"]
}

export interface AuthoredCandidate {
  name?: string
  hypothesis: string
  differsFromPrior: string
  expectedFailureIfWrong: string
  seededFrom: string
  /** Strategy markdown: prose + optional ```ts fences. */
  body: string
}

export type EvoAuthor = (request: AuthorRequest) => Promise<AuthoredCandidate[]>

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8")
  fs.renameSync(tmp, file)
}

function atomicWriteText(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`
  fs.writeFileSync(tmp, content, "utf-8")
  fs.renameSync(tmp, file)
}

function readJson(file: string): unknown | null {
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, "utf-8"))
  } catch {
    return null
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

/** iter1 → A,B,C…; iter2 → A2,B2… */
function candidateName(index: number, iteration: number): string {
  const letter = String.fromCharCode(65 + (index % 26))
  return iteration === 1 ? letter : `${letter}${iteration}`
}

/** A trial errored when the child never got to produce real output. */
function spawnErrored(r: SubagentResult): boolean {
  return (
    r.output.startsWith("cannot re-invoke momo") ||
    r.output.startsWith("RLM depth limit reached") ||
    r.stderrOutput.includes("[spawn error:") ||
    r.timedOut
  )
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** True when the last two per-iteration best improvements are both < 5pp. */
export function isPlateau(history: number[]): boolean {
  if (history.length < 3) return false
  const n = history.length
  const last = history[n - 1] - history[n - 2]
  const prev = history[n - 2] - history[n - 3]
  return last < 0.05 && prev < 0.05
}

/** Top-`k` survivors: evaluated only, sorted by (passRate desc, errors asc). */
export function pickSurvivors(candidates: EvoCandidate[], k = 3): EvoCandidate[] {
  return candidates
    .filter((c) => c.status === "evaluated")
    .sort((a, b) => b.passRate - a.passRate || a.errors - b.errors)
    .slice(0, k)
}

/** Stop-condition check, run at the top of each loop iteration. */
export function computeStop(
  state: { iteration: number; bestPassRate: number; history: number[] },
  threshold: number,
  maxIterations: number,
): { stop: boolean; reason?: StopReason } {
  if (state.bestPassRate >= threshold) return { stop: true, reason: "solved" }
  if (state.iteration >= maxIterations) return { stop: true, reason: "max-iterations" }
  if (isPlateau(state.history)) return { stop: true, reason: "plateau" }
  return { stop: false }
}

// ---------------------------------------------------------------------------
// init / load
// ---------------------------------------------------------------------------

function validateTask(raw: unknown): SkillTask {
  const t = raw as SkillTask
  if (!isRecord(raw) || typeof t.id !== "string" || !t.id.trim()) {
    throw new Error("task JSON must have a non-empty string 'id'")
  }
  if (typeof t.prompt !== "string" || !t.prompt.trim()) {
    throw new Error(`task '${t.id}': prompt must be a non-empty string`)
  }
  if (t.band !== "dev" && t.band !== "heldout") {
    throw new Error(`task '${t.id}': band must be "dev" or "heldout"`)
  }
  assertCheckAllowed(typeof t.check === "string" ? t.check : "")
  return { id: t.id.trim(), prompt: t.prompt, check: String(t.check), band: t.band }
}

/**
 * Create `<outDir>/evosearch-<task.id>-<stamp>/` (default outDir:
 * `<momoHome>/skill-campaigns`) with an initial state.json:
 * iteration 0, empty population, empty eliminated ledger.
 */
export function initEvosearch(opts: {
  task: SkillTask
  k?: number
  outDir?: string
}): EvoState {
  const task = validateTask(opts.task)
  const k = opts.k ?? (Number(process.env.MOMO_ASPIRE_EVO_K || 6) || 6)
  if (k < 1) throw new Error(`k must be >= 1, got ${k}`)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const dir = path.join(
    opts.outDir ?? getSkillCampaignsDir(),
    `evosearch-${task.id}-${stamp}`,
  )
  fs.mkdirSync(dir, { recursive: true })
  const state: EvoState = {
    schemaVersion: 1,
    dir,
    task,
    k,
    iteration: 0,
    eliminated: [],
    candidates: [],
  }
  atomicWriteJson(path.join(dir, "state.json"), state)
  return state
}

/** Load state.json from an evosearch directory. */
export function loadEvoState(dir: string): EvoState {
  const raw = readJson(path.join(dir, "state.json"))
  if (!isRecord(raw)) throw new Error(`not an evosearch directory: ${dir}`)
  return raw as unknown as EvoState
}

function saveState(state: EvoState): void {
  atomicWriteJson(path.join(state.dir, "state.json"), state)
}

// ---------------------------------------------------------------------------
// Candidate staging + evaluation
// ---------------------------------------------------------------------------

function stageCandidateFile(
  state: EvoState,
  iteration: number,
  name: string,
  authored: AuthoredCandidate,
): string {
  const file = path.join(state.dir, `iter${iteration}`, `candidate_${name}.md`)
  const fm = [
    "---",
    `name: ${name}`,
    `hypothesis: ${authored.hypothesis.replace(/\s*\n\s*/g, " ").trim()}`,
    `differs_from_prior: ${authored.differsFromPrior.replace(/\s*\n\s*/g, " ").trim()}`,
    `expected_failure_if_wrong: ${authored.expectedFailureIfWrong.replace(/\s*\n\s*/g, " ").trim()}`,
    `seeded_from: ${authored.seededFrom.trim()}`,
    "---",
    "",
    authored.body.trim(),
    "",
  ].join("\n")
  atomicWriteText(file, fm)
  return file
}

function stageEvalPrompt(
  state: EvoState,
  iteration: number,
  candidate: EvoCandidate,
  evalDir: string,
): string {
  const promptFile = path.join(
    state.dir,
    `iter${iteration}`,
    `candidate_${candidate.name}_PROMPT.md`,
  )
  const parts = [
    `# Candidate evaluation — task ${state.task.id}, candidate ${candidate.name}`,
    "",
    "## Task",
    "",
    state.task.prompt.trim(),
    "",
    "Check command (exit 0 = task solved):",
    "",
    "```sh",
    state.task.check,
    "```",
    "",
    "## Candidate strategy (your ONLY guidance)",
    "",
    `hypothesis: ${candidate.hypothesis}`,
    `seeded_from: ${candidate.seededFrom}`,
    "",
    fs.readFileSync(candidate.codePath, "utf-8").trim(),
    "",
    "## Rules",
    "",
    "- Use ONLY the strategy above. Do not consult the skill library or any",
    "  other candidate's artifacts — the strategy text must stand alone.",
    `  Everything you write must go into ${evalDir} (your working directory).`,
    "- Write `outcome.json` into that directory before you finish:",
    "",
    '```json',
    '{ "pass": true, "stage": "<where it failed, if it did>", "reason": "<one line>" }',
    "```",
    "",
    "`pass` must be true iff the check command exited 0.",
    "",
  ].join("\n")
  atomicWriteText(promptFile, parts)
  return promptFile
}

// ---------------------------------------------------------------------------
// Default LLM author (chatComplete-based)
// ---------------------------------------------------------------------------

const AUTHOR_SYSTEM = `You author strategy candidates for an evolutionary search over coding-task strategies.

Every candidate MUST record, in its fields:
- hypothesis: what you believe will make the task succeed
- differs_from_prior: the STRUCTURAL difference from prior candidates — an
  approach, architecture, or technique difference, never a parameter tweak
- expected_failure_if_wrong: where and how this candidate fails if the
  hypothesis is wrong
- seeded_from: "novel", or the names of the survivor candidates it seeds from

Diversity rules (hard constraints):
- Do NOT re-test anything on the eliminated ledger without a revival_reason
  explaining the new structural idea that could overturn the elimination.
- No two new candidates may target the same failure stage+reason as an
  existing eliminated entry without a new structural reason.
- At least one candidate must be structurally novel (seeded_from: "novel").
- When survivors exist, seed at least one candidate from them.

Answer with STRICT JSON only: {"candidates":[{hypothesis,differs_from_prior,expected_failure_if_wrong,seeded_from,body}]} where body is a markdown strategy (prose plus optional ts fenced code).`

function formatSurvivors(survivors: EvoCandidate[]): string {
  if (survivors.length === 0) return "(none yet — author novel candidates)"
  return survivors
    .map((s) => `- ${s.name}: passRate ${s.passRate}, hypothesis: ${s.hypothesis}`)
    .join("\n")
}

function formatEliminated(eliminated: EvoState["eliminated"]): string {
  if (eliminated.length === 0) return "(empty)"
  return eliminated
    .map((e) => `- [iter ${e.iteration}] ${e.hypothesis} — ${e.reason}`)
    .join("\n")
}

/** Default author: asks the configured LLM for K disciplined candidates. */
export const llmAuthor: EvoAuthor = async (request) => {
  const config = await resolveProviderConfig()
  if (!config || !config.baseUrl) {
    throw new Error("no provider configured (set MOMO_API_KEY)")
  }
  const responseText = await chatComplete({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    system: AUTHOR_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          `Author ${request.k} strategy candidates for this coding task.`,
          "",
          "Task:",
          request.task.prompt,
          "",
          `Check command: ${request.task.check}`,
          "",
          `Iteration: ${request.iteration}`,
          "",
          "Survivors (top performers so far — seed material):",
          formatSurvivors(request.survivors),
          "",
          "Eliminated ledger (do not re-test without revival_reason):",
          formatEliminated(request.eliminated),
        ].join("\n"),
      },
    ],
    stream: false,
    temperature: 0.7,
  })

  const parsed = extractJsonObject(responseText)
  if (!isRecord(parsed) || !Array.isArray(parsed.candidates)) {
    throw new Error("author did not return a JSON object with a 'candidates' array")
  }
  const authored: AuthoredCandidate[] = []
  for (const c of parsed.candidates) {
    if (!isRecord(c)) continue
    if (typeof c.hypothesis !== "string" || typeof c.body !== "string") continue
    authored.push({
      hypothesis: c.hypothesis,
      differsFromPrior: typeof c.differs_from_prior === "string" ? c.differs_from_prior : "",
      expectedFailureIfWrong:
        typeof c.expected_failure_if_wrong === "string" ? c.expected_failure_if_wrong : "",
      seededFrom: typeof c.seeded_from === "string" ? c.seeded_from : "novel",
      body: c.body,
    })
  }
  return authored.slice(0, request.k)
}

// ---------------------------------------------------------------------------
// Default event printer
// ---------------------------------------------------------------------------

/** One-line DIM summaries; the CLI substitutes a prettier printer. */
export function printEvoEvent(event: EvoEvent): void {
  switch (event.kind) {
    case "iteration-start":
      console.log(`${DIM}[evosearch] iteration ${event.iteration}: authoring ${event.k} candidate(s)${RESET}`)
      break
    case "candidate-authored":
      console.log(`${DIM}[evosearch] iter ${event.iteration}: candidate ${event.name} (seeded from ${event.seededFrom})${RESET}`)
      break
    case "candidate-attempt":
      console.log(
        `${DIM}[evosearch] iter ${event.iteration}: ${event.name} attempt ${event.attempt} → ${event.pass ? "pass" : "fail"}${RESET}`,
      )
      break
    case "candidate-evaluated":
      console.log(
        `${DIM}[evosearch] iter ${event.iteration}: ${event.name} → ${event.pass ? "PASS" : `FAIL ${event.stage ?? ""} ${event.reason ?? ""}`}${RESET}`,
      )
      break
    case "leaderboard":
      console.log(
        `${DIM}[evosearch] iter ${event.iteration}: best ${event.best ?? "(none)"} @ ${event.bestPassRate}${RESET}`,
      )
      break
    case "evosearch-done":
      console.log(
        `${DIM}[evosearch] done (${event.stopReason}): best ${event.best ?? "(none)"} @ ${event.bestPassRate}${RESET}`,
      )
      break
  }
}

// ---------------------------------------------------------------------------
// runEvosearch
// ---------------------------------------------------------------------------

export interface RunEvosearchOpts {
  stateDir: string
  maxIterations?: number
  threshold?: number
  /** Max attempts per candidate (fail-fast racing; default 3, min 1). */
  trials?: number
  onEvent?: (event: EvoEvent) => void
  spawnRunner?: SpawnRunner
  author?: EvoAuthor
}

/**
 * Run the evolutionary search to a stop condition:
 *
 * 1. check stop conditions (solved / max-iterations / plateau);
 * 2. eliminate every evaluated non-survivor into the ledger, with a reason
 *    parsed from its failures;
 * 3. author K candidates (diversity rules enforced via the author prompt /
 *    AuthorRequest), write them as iter<N>/candidate_<X>.md;
 * 4. evaluate each candidate with independent worker subagents (fail-fast
 *    racing, up to `trials` attempts; task check command = fitness;
 *    outcome.json, exit-code fallback);
 * 5. write iter<N>/leaderboard.json, keep the top-3 survivors.
 *
 * On completion: copies the best candidate to evosearch_best.md and writes
 * evosearch_report.json. Returns the final state.
 */
export async function runEvosearch(opts: RunEvosearchOpts): Promise<EvoState> {
  const state = loadEvoState(opts.stateDir)
  const emit = opts.onEvent ?? printEvoEvent
  const run: SpawnRunner = opts.spawnRunner ?? spawnSubagent
  const author = opts.author ?? llmAuthor
  const threshold =
    opts.threshold ?? (Number(process.env.MOMO_ASPIRE_EVO_THRESHOLD || 0.8) || 0.8)
  const maxIterations =
    opts.maxIterations ?? (Number(process.env.MOMO_ASPIRE_EVO_MAX_ITER || 5) || 5)
  const trials = Math.max(1, Math.floor(
    opts.trials ?? (Number(process.env.MOMO_ASPIRE_EVO_TRIALS || 3) || 3),
  ))
  const concurrency =
    Number(process.env.MOMO_ASPIRE_CONCURRENCY || 2) || 2
  const taskTimeoutMs =
    Number(process.env.MOMO_ASPIRE_TASK_TIMEOUT_MS || 900_000) || 900_000

  const history: number[] = []
  for (;;) {
    const best = pickSurvivors(state.candidates)[0] ?? null
    const stop = computeStop(
      {
        iteration: state.iteration,
        bestPassRate: best?.passRate ?? 0,
        history,
      },
      threshold,
      maxIterations,
    )
    if (stop.stop) {
      state.stopReason = stop.reason
      break
    }

    state.iteration++
    const iteration = state.iteration
    emit({ kind: "iteration-start", iteration, k: state.k })

    // eliminate losers (evaluated, not in the survivor set)
    const survivors = pickSurvivors(state.candidates)
    const survivorNames = new Set(survivors.map((s) => s.name))
    for (const c of state.candidates) {
      if (c.status !== "evaluated" || survivorNames.has(c.name)) continue
      c.status = "eliminated"
      const passes = Math.round(c.passRate * c.trials)
      const reason =
        passes > 0
          ? `unreliable: ${passes}/${c.trials} attempts passed — ${c.failures
              .map((f) => `${f.stage}: ${f.reason}`)
              .join("; ")}`
          : c.failures.length > 0
            ? c.failures.map((f) => `${f.stage}: ${f.reason}`).join("; ")
            : "outperformed by survivors"
      state.eliminated.push({ hypothesis: c.hypothesis, reason, iteration })
    }

    // author the next population (ledger copied: requests must be snapshots)
    const authored = await author({
      task: state.task,
      k: state.k,
      iteration,
      survivors,
      eliminated: state.eliminated.map((e) => ({ ...e })),
    })
    const batch: EvoCandidate[] = []
    authored.forEach((a, i) => {
      const name = (a.name ?? candidateName(i, iteration)).trim()
      const codePath = stageCandidateFile(state, iteration, name, a)
      batch.push({
        name,
        codePath,
        hypothesis: a.hypothesis,
        seededFrom: a.seededFrom,
        status: "pending",
        passRate: 0,
        errors: 0,
        trials: 0,
        failures: [],
      })
      emit({ kind: "candidate-authored", iteration, name, seededFrom: a.seededFrom })
    })
    state.candidates.push(...batch)
    saveState(state)

    // evaluate the population with fail-fast racing: every candidate gets
    // one trial; a failure ends its run (eliminated, as before), a pass
    // buys a confirmation trial — up to `trials` total. A flaky pass
    // (passed once, failed a confirmation) can therefore never reach the
    // survivor pool or trigger "solved"; the extra cost is paid only by
    // candidates that actually passed.
    const race: Array<{
      candidate: EvoCandidate
      passes: number
      done: boolean
    }> = batch.map((candidate) => ({ candidate, passes: 0, done: false }))
    for (let attempt = 1; attempt <= trials; attempt++) {
      const runnable = race.filter((r) => !r.done)
      if (runnable.length === 0) break
      for (let i = 0; i < runnable.length; i += concurrency) {
        await Promise.all(
          runnable.slice(i, i + concurrency).map(async (r) => {
            const candidate = r.candidate
            const evalDir = path.join(
              state.dir,
              `iter${iteration}`,
              `eval_${candidate.name}`,
              `attempt${attempt}`,
            )
            fs.mkdirSync(evalDir, { recursive: true })
            const promptFile = stageEvalPrompt(state, iteration, candidate, evalDir)
            const result = await run(`candidate ${candidate.name} (iter ${iteration})`, {
              args: [
                // The eval dir is followed by a space on purpose — a trailing
                // "." would leave `\S+` path parsers pointing at a dot-suffixed
                // directory that does not exist.
                `Read the file ${promptFile} and follow it exactly. Work only inside ${evalDir} and write outcome.json there before you finish.`,
              ],
              timeoutMs: taskTimeoutMs,
            })
            const errored = spawnErrored(result)
            const outcome = readJson(path.join(evalDir, "outcome.json"))
            const pass = errored
              ? false
              : isRecord(outcome) && typeof outcome.pass === "boolean"
                ? outcome.pass
                : result.exitCode === 0
            const stage =
              !pass && isRecord(outcome) && typeof outcome.stage === "string"
                ? outcome.stage
                : !pass
                  ? "check"
                  : undefined
            const reason =
              !pass && isRecord(outcome) && typeof outcome.reason === "string"
                ? outcome.reason
                : !pass
                  ? (result.output.slice(-200).trim() || "check command failed")
                  : undefined

            r.done = !pass
            if (pass) r.passes++
            if (errored) candidate.errors++
            if (!pass) {
              candidate.failures.push({
                stage: stage ?? "unknown",
                reason: reason ?? "check command failed",
              })
            }
            emit({
              kind: "candidate-attempt",
              iteration,
              name: candidate.name,
              attempt,
              pass,
            })
          }),
        )
      }
    }
    for (const r of race) {
      const candidate = r.candidate
      candidate.status = "evaluated"
      candidate.trials = candidate.failures.length + r.passes
      candidate.passRate = candidate.trials > 0 ? r.passes / candidate.trials : 0
      const firstFailure = candidate.failures[0]
      emit({
        kind: "candidate-evaluated",
        iteration,
        name: candidate.name,
        pass: candidate.failures.length === 0,
        stage: firstFailure?.stage,
        reason:
          candidate.failures.length > 0 && r.passes > 0
            ? `unreliable: ${r.passes}/${candidate.trials} attempts passed`
            : firstFailure?.reason,
      })
    }

    // leaderboard for this iteration
    const board = batch
      .slice()
      .sort((a, b) => b.passRate - a.passRate || a.errors - b.errors)
    const boardBest = board[0] ?? null
    atomicWriteJson(path.join(state.dir, `iter${iteration}`, "leaderboard.json"), {
      iteration,
      candidates: board.map((c) => ({
        name: c.name,
        passRate: c.passRate,
        errors: c.errors,
        failures: c.failures,
      })),
      best: boardBest?.name ?? null,
      bestPassRate: boardBest?.passRate ?? 0,
    })
    const globalBest = pickSurvivors(state.candidates)[0] ?? null
    history.push(globalBest?.passRate ?? 0)
    emit({
      kind: "leaderboard",
      iteration,
      best: globalBest?.name ?? null,
      bestPassRate: globalBest?.passRate ?? 0,
    })
    saveState(state)
  }

  // finalize
  const best = pickSurvivors(state.candidates)[0] ?? null
  if (best) {
    atomicWriteText(
      path.join(state.dir, "evosearch_best.md"),
      fs.readFileSync(best.codePath, "utf-8"),
    )
  }
  const report = {
    taskId: state.task.id,
    iterations: state.iteration,
    stopReason: state.stopReason,
    best: best ? { name: best.name, passRate: best.passRate } : null,
    eliminatedCount: state.eliminated.length,
    ledger: state.eliminated,
  }
  atomicWriteJson(path.join(state.dir, "evosearch_report.json"), report)
  saveState(state)

  emit({
    kind: "evosearch-done",
    stopReason: state.stopReason ?? "max-iterations",
    best: best?.name ?? null,
    bestPassRate: best?.passRate ?? 0,
  })
  return state
}
