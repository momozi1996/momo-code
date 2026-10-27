import { describe, it, after } from "node:test"
import assert from "node:assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  initEvosearch,
  runEvosearch,
  loadEvoState,
  isPlateau,
  pickSurvivors,
  computeStop,
  type AuthorRequest,
  type AuthoredCandidate,
  type EvoCandidate,
  type EvoEvent,
  type EvoState,
} from "../skill/evosearch"
import type { SpawnRunner } from "../skill/coordinator"
import type { SubagentResult } from "../subagent/spawn"
import type { SkillTask } from "../skill/schema"

// ---------------------------------------------------------------------------
// Per-test home isolation.
// ---------------------------------------------------------------------------

const homes: string[] = []
let savedHome: string | undefined

function useHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-evosearch-"))
  homes.push(dir)
  if (savedHome === undefined) savedHome = process.env.MOMO_CONFIG_DIR
  process.env.MOMO_CONFIG_DIR = dir
  return dir
}

after(() => {
  if (savedHome === undefined) delete process.env.MOMO_CONFIG_DIR
  else process.env.MOMO_CONFIG_DIR = savedHome
  for (const dir of homes) fs.rmSync(dir, { recursive: true, force: true })
})

const TASK: SkillTask = { id: "median-1", prompt: "Implement median.", check: "npm test", band: "dev" }

// ---------------------------------------------------------------------------
// Fakes: a recording deterministic author + a scripted runner.
// ---------------------------------------------------------------------------

function makeFakeAuthor(): {
  author: (req: AuthorRequest) => Promise<AuthoredCandidate[]>
  requests: AuthorRequest[]
} {
  const requests: AuthorRequest[] = []
  const author = async (req: AuthorRequest): Promise<AuthoredCandidate[]> => {
    requests.push(req)
    return Array.from({ length: req.k }, (_, i) => ({
      hypothesis: `hypothesis ${String.fromCharCode(65 + i)} for iteration ${req.iteration}`,
      differsFromPrior: `structure ${i} differs from all prior candidates`,
      expectedFailureIfWrong: `fails at stage-${i} if wrong`,
      seededFrom: req.iteration === 1 ? "novel" : req.survivors[0]?.name ?? "novel",
      body: [
        `Strategy ${String.fromCharCode(65 + i)}: try approach ${i}.`,
        "",
        "```ts",
        "export function attempt(xs: number[]): number {",
        "  return xs.length",
        "}",
        "```",
      ].join("\n"),
    }))
  }
  return { author, requests }
}

function fakeResult(task: string, exitCode: number): SubagentResult {
  return { task, output: "done", stderrOutput: "", exitCode, durationMs: 1, timedOut: false, depth: 1 }
}

function makeFakeRunner(
  decide: (iteration: number, name: string) => { pass: boolean; stage?: string; reason?: string },
): { runner: SpawnRunner; evals: Array<{ iteration: number; name: string }> } {
  const evals: Array<{ iteration: number; name: string }> = []
  const runner: SpawnRunner = async (task, spawnOpts) => {
    const instruction = spawnOpts.args?.[0] ?? ""
    const fileMatch = /Read the file (\S+) and/.exec(instruction)
    const dirMatch = /Work only inside (\S+)/.exec(instruction)
    const nameMatch = /candidate_([A-Z]+\d*)_PROMPT\.md/.exec(instruction)
    const iterMatch = /iter(\d+)/.exec(instruction)
    if (!fileMatch || !dirMatch || !nameMatch || !iterMatch) {
      throw new Error(`fake runner: cannot parse instruction: ${instruction}`)
    }
    const iteration = Number(iterMatch[1])
    const name = nameMatch[1]
    evals.push({ iteration, name })
    const outcome = decide(iteration, name)
    fs.mkdirSync(dirMatch[1], { recursive: true })
    fs.writeFileSync(
      path.join(dirMatch[1], "outcome.json"),
      JSON.stringify({ pass: outcome.pass, stage: outcome.stage, reason: outcome.reason }),
    )
    return fakeResult(task, outcome.pass ? 0 : 1)
  }
  return { runner, evals }
}

/** Like makeFakeRunner, but the script sees the racing attempt number. */
function makeAttemptRunner(
  decide: (iteration: number, name: string, attempt: number) => { pass: boolean; stage?: string; reason?: string },
): { runner: SpawnRunner; evals: Array<{ iteration: number; name: string; attempt: number }> } {
  const evals: Array<{ iteration: number; name: string; attempt: number }> = []
  const runner: SpawnRunner = async (task, spawnOpts) => {
    const instruction = spawnOpts.args?.[0] ?? ""
    const fileMatch = /Read the file (\S+) and/.exec(instruction)
    const dirMatch = /Work only inside (\S+)/.exec(instruction)
    const nameMatch = /candidate_([A-Z]+\d*)_PROMPT\.md/.exec(instruction)
    const iterMatch = /iter(\d+)/.exec(instruction)
    const attemptMatch = /attempt(\d+)/.exec(dirMatch?.[1] ?? "")
    if (!fileMatch || !dirMatch || !nameMatch || !iterMatch || !attemptMatch) {
      throw new Error(`fake runner: cannot parse instruction: ${instruction}`)
    }
    const iteration = Number(iterMatch[1])
    const name = nameMatch[1]
    const attempt = Number(attemptMatch[1])
    evals.push({ iteration, name, attempt })
    const outcome = decide(iteration, name, attempt)
    fs.mkdirSync(dirMatch[1], { recursive: true })
    fs.writeFileSync(
      path.join(dirMatch[1], "outcome.json"),
      JSON.stringify({ pass: outcome.pass, stage: outcome.stage, reason: outcome.reason }),
    )
    return fakeResult(task, outcome.pass ? 0 : 1)
  }
  return { runner, evals }
}

function candidate(partial: Partial<EvoCandidate> & { name: string }): EvoCandidate {
  return {
    codePath: `iter1/candidate_${partial.name}.md`,
    hypothesis: `hyp ${partial.name}`,
    seededFrom: "novel",
    status: "evaluated",
    passRate: 0,
    errors: 0,
    trials: 1,
    failures: [],
    ...partial,
  }
}

// ---------------------------------------------------------------------------

describe("skill/evosearch pure helpers", () => {
  it("isPlateau: last two improvements both < 5pp", () => {
    assert.strictEqual(isPlateau([]), false)
    assert.strictEqual(isPlateau([0, 0]), false)
    assert.strictEqual(isPlateau([0, 0, 0]), true)
    assert.strictEqual(isPlateau([0.5, 0.52, 0.54]), true)
    assert.strictEqual(isPlateau([0.5, 0.55, 0.54]), false) // 0.05 is not < 0.05
    assert.strictEqual(isPlateau([0, 1, 1]), false) // +1.0 then 0
    assert.strictEqual(isPlateau([0, 0, 0, 1, 1]), false)
  })

  it("pickSurvivors: evaluated only, (passRate desc, errors asc), top-3", () => {
    const all = [
      candidate({ name: "A", passRate: 1, errors: 0 }),
      candidate({ name: "B", passRate: 0.5, errors: 1 }),
      candidate({ name: "C", passRate: 0.5, errors: 0 }),
      candidate({ name: "D", passRate: 0, errors: 0 }),
      candidate({ name: "E", passRate: 1, errors: 2 }),
      candidate({ name: "F", status: "pending" }),
      candidate({ name: "G", status: "eliminated", passRate: 1, errors: 0 }),
    ]
    const survivors = pickSurvivors(all)
    assert.deepStrictEqual(
      survivors.map((s) => s.name),
      ["A", "E", "C"],
    )
    assert.deepStrictEqual(pickSurvivors(all, 2).map((s) => s.name), ["A", "E"])
    assert.deepStrictEqual(pickSurvivors([]), [])
  })

  it("computeStop: solved beats max-iterations beats plateau", () => {
    const base = { iteration: 3, bestPassRate: 0.5, history: [0, 0.25, 0.5] }
    assert.deepStrictEqual(computeStop(base, 0.8, 5), { stop: false })
    assert.deepStrictEqual(computeStop({ ...base, bestPassRate: 0.9 }, 0.8, 5), {
      stop: true,
      reason: "solved",
    })
    assert.deepStrictEqual(computeStop({ ...base, bestPassRate: 1 }, 0.8, 3), {
      stop: true,
      reason: "solved",
    })
    assert.deepStrictEqual(computeStop(base, 0.8, 3), { stop: true, reason: "max-iterations" })
    assert.deepStrictEqual(computeStop({ iteration: 3, bestPassRate: 0.4, history: [0, 0, 0] }, 0.8, 5), {
      stop: true,
      reason: "plateau",
    })
  })
})

describe("skill/evosearch runEvosearch (fake author + runner)", () => {
  it("stops solved when the threshold is met; best + report on disk", async () => {
    useHome()
    const state = initEvosearch({ task: TASK, k: 3 })
    assert.match(path.basename(state.dir), /^evosearch-median-1-/)
    assert.deepStrictEqual(
      { iteration: state.iteration, eliminated: state.eliminated, candidates: state.candidates },
      { iteration: 0, eliminated: [], candidates: [] },
    )

    const { author, requests } = makeFakeAuthor()
    const { runner, evals } = makeFakeRunner((_iter, name) =>
      name === "A" ? { pass: true } : { pass: false, stage: "impl", reason: "approach broke" },
    )
    const events: EvoEvent[] = []
    const final = await runEvosearch({
      stateDir: state.dir,
      threshold: 0.8,
      maxIterations: 5,
      author,
      spawnRunner: runner,
      onEvent: (e) => events.push(e),
    })

    assert.strictEqual(final.stopReason, "solved")
    assert.strictEqual(final.iteration, 1)
    // fail-fast racing: B and C stop after their failing first attempt;
    // A confirms its pass with two extra attempts (default trials = 3)
    assert.deepStrictEqual(
      evals.map((e) => e.name).sort(),
      ["A", "A", "A", "B", "C"],
    )
    const a = final.candidates.find((c) => c.name === "A")!
    assert.strictEqual(a.trials, 3)
    assert.strictEqual(a.passRate, 1)

    // best candidate copied + report written
    const best = fs.readFileSync(path.join(state.dir, "evosearch_best.md"), "utf-8")
    assert.match(best, /hypothesis A for iteration 1/)
    const report = JSON.parse(
      fs.readFileSync(path.join(state.dir, "evosearch_report.json"), "utf-8"),
    )
    assert.strictEqual(report.stopReason, "solved")
    assert.deepStrictEqual(report.best, { name: "A", passRate: 1 })
    assert.strictEqual(report.taskId, "median-1")
    assert.strictEqual(report.iterations, 1)

    // candidate file with ASPIRE docstring discipline frontmatter
    const cand = fs.readFileSync(path.join(state.dir, "iter1", "candidate_A.md"), "utf-8")
    assert.match(cand, /hypothesis: hypothesis A/)
    assert.match(cand, /differs_from_prior: structure 0/)
    assert.match(cand, /expected_failure_if_wrong: fails at stage-0/)
    assert.match(cand, /seeded_from: novel/)

    // leaderboard
    const board = JSON.parse(
      fs.readFileSync(path.join(state.dir, "iter1", "leaderboard.json"), "utf-8"),
    )
    assert.strictEqual(board.best, "A")
    assert.strictEqual(board.bestPassRate, 1)
    assert.strictEqual(board.candidates.length, 3)

    // event coverage
    const kinds = events.map((e) => e.kind)
    assert.strictEqual(kinds.filter((k) => k === "iteration-start").length, 1)
    assert.strictEqual(kinds.filter((k) => k === "candidate-authored").length, 3)
    assert.strictEqual(kinds.filter((k) => k === "candidate-evaluated").length, 3)
    assert.ok(kinds.includes("leaderboard"))
    assert.strictEqual(kinds[kinds.length - 1], "evosearch-done")

    // state.json persisted with the stop reason
    const onDisk = loadEvoState(state.dir)
    assert.strictEqual(onDisk.stopReason, "solved")
    assert.strictEqual(requests.length, 1)
  })

  it("stops on plateau after two <5pp iterations; ledger feeds the author", async () => {
    useHome()
    // k=4 > survivor slots (3), so every iteration has losers to eliminate
    const state = initEvosearch({ task: TASK, k: 4 })
    const { author, requests } = makeFakeAuthor()
    const { runner } = makeFakeRunner(() => ({ pass: false, stage: "impl", reason: "always fails" }))
    const events: EvoEvent[] = []

    const final = await runEvosearch({
      stateDir: state.dir,
      threshold: 0.8,
      maxIterations: 10,
      author,
      spawnRunner: runner,
    })

    assert.strictEqual(final.stopReason, "plateau")
    assert.strictEqual(final.iteration, 3)
    // iter2 eliminates iter1's 1 loser; iter3 eliminates 4 of the remaining 7
    assert.strictEqual(final.eliminated.length, 5)
    assert.ok(final.eliminated.every((e) => /impl: always fails/.test(e.reason)))

    // the author saw the ledger grow between iterations
    assert.strictEqual(requests.length, 3)
    assert.deepStrictEqual(
      requests.map((r) => r.eliminated.length),
      [0, 1, 5],
    )
    // iteration 2+ requests carry survivors from iteration 1
    assert.strictEqual(requests[1].survivors.length, 3)
    // leaderboard files per iteration
    for (const i of [1, 2, 3]) {
      assert.ok(fs.existsSync(path.join(state.dir, `iter${i}`, "leaderboard.json")))
    }
    // the best (least-bad) candidate is kept even though nothing passed
    const best = fs.readFileSync(path.join(state.dir, "evosearch_best.md"), "utf-8")
    assert.match(best, /hypothesis A for iteration 1/)
    const report = JSON.parse(
      fs.readFileSync(path.join(state.dir, "evosearch_report.json"), "utf-8"),
    )
    assert.strictEqual(report.stopReason, "plateau")
    assert.strictEqual(report.eliminatedCount, 5)
    assert.strictEqual(report.ledger.length, 5)
  })

  it("stops on max-iterations", async () => {
    useHome()
    const state = initEvosearch({ task: TASK, k: 1 })
    const { author } = makeFakeAuthor()
    const { runner } = makeFakeRunner(() => ({ pass: false, stage: "check", reason: "nope" }))

    const final = await runEvosearch({
      stateDir: state.dir,
      threshold: 0.8,
      maxIterations: 2,
      author,
      spawnRunner: runner,
    })

    assert.strictEqual(final.stopReason, "max-iterations")
    assert.strictEqual(final.iteration, 2)
  })

  it("candidate names are per-iteration (iter1: A.., iter2: A2..)", async () => {
    useHome()
    // threshold unreachable (passRate ≤ 1 < 1.01), maxIterations 2 → two
    // full iterations regardless of outcomes
    const state = initEvosearch({ task: TASK, k: 2 })
    const { author } = makeFakeAuthor()
    const { runner, evals } = makeFakeRunner(() => ({ pass: false, stage: "s", reason: "r" }))

    const final = await runEvosearch({
      stateDir: state.dir,
      threshold: 1.01,
      maxIterations: 2,
      author,
      spawnRunner: runner,
    })
    assert.strictEqual(final.iteration, 2)
    assert.deepStrictEqual(
      evals.map((e) => e.name).sort(),
      ["A", "A2", "B", "B2"],
    )
  })

  it("racing filters flaky passes: one pass then a fail is not 'solved'", async () => {
    useHome()
    const state = initEvosearch({ task: TASK, k: 4 })
    const { author } = makeFakeAuthor()
    // iter1 A: attempt 1 passes, attempt 2 fails → unreliable (1/2 = 0.5).
    // iter1 B/C/D: pass attempts 1-2, fail attempt 3 → 2/3 ≈ 0.67 — above A,
    // below the 0.8 threshold, so the run continues without "solved".
    // iter2 candidates: fail immediately.
    const { runner, evals } = makeAttemptRunner((iter, name, attempt) => {
      if (iter === 2) return { pass: false, stage: "impl", reason: "regressed" }
      if (name === "A") {
        return attempt === 1
          ? { pass: true }
          : { pass: false, stage: "impl", reason: "flaky strategy" }
      }
      return attempt <= 2
        ? { pass: true }
        : { pass: false, stage: "impl", reason: "not repeatable" }
    })
    const events: EvoEvent[] = []

    const final = await runEvosearch({
      stateDir: state.dir,
      threshold: 0.8,
      maxIterations: 2,
      author,
      spawnRunner: runner,
      onEvent: (e) => events.push(e),
    })

    // The flaky first-attempt pass never triggers the solved stop condition.
    assert.strictEqual(final.stopReason, "max-iterations")
    const a = final.candidates.find((c) => c.name === "A")!
    assert.strictEqual(a.trials, 2)
    assert.strictEqual(a.passRate, 0.5)
    assert.deepStrictEqual(a.failures, [{ stage: "impl", reason: "flaky strategy" }])
    // The reliable-but-imperfect majority pushed A out of the survivor set;
    // its ledger entry tells the author the pass was unreliable
    assert.strictEqual(a.status, "eliminated")
    const ledgerA = final.eliminated.find((e) => e.hypothesis === a.hypothesis)
    assert.match(ledgerA!.reason, /unreliable: 1\/2 attempts passed/)
    // 2/3 candidates ran all three attempts and survive at 2/3
    const b = final.candidates.find((c) => c.name === "B")!
    assert.strictEqual(b.trials, 3)
    assert.strictEqual(b.passRate, 2 / 3)
    assert.strictEqual(b.status, "evaluated")
    // The evaluated verdict for A reports the failure with the reliability note
    const evaluated = events.find(
      (e) => e.kind === "candidate-evaluated" && (e as { name: string }).name === "A",
    ) as { reason?: string }
    assert.match(evaluated.reason!, /unreliable: 1\/2 attempts passed/)
    // attempt-level progress events were emitted (A stops after 2 attempts)
    const aAttempts = events.filter(
      (e) => e.kind === "candidate-attempt" && (e as { name: string }).name === "A",
    )
    assert.strictEqual(aAttempts.length, 2)
    // and the racing order is visible in the runner calls
    assert.deepStrictEqual(
      evals.filter((e) => e.name === "A").map((e) => e.attempt),
      [1, 2],
    )
  })

  it("trials: 1 keeps the historical single-attempt evaluation", async () => {
    useHome()
    const state = initEvosearch({ task: TASK, k: 2 })
    const { author } = makeFakeAuthor()
    const { runner, evals } = makeAttemptRunner((_iter, name) =>
      name.startsWith("A") ? { pass: true } : { pass: false, stage: "s", reason: "r" },
    )

    const final = await runEvosearch({
      stateDir: state.dir,
      threshold: 0.8,
      maxIterations: 1,
      trials: 1,
      author,
      spawnRunner: runner,
    })

    assert.strictEqual(final.stopReason, "solved")
    assert.deepStrictEqual(
      evals.map((e) => `${e.name}#${e.attempt}`),
      ["A#1", "B#1"],
    )
    const a = final.candidates.find((c) => c.name === "A")!
    assert.strictEqual(a.trials, 1)
    assert.strictEqual(a.passRate, 1)
  })
})

describe("skill/evosearch initEvosearch validation", () => {
  it("rejects bad tasks", () => {
    useHome()
    assert.throws(() => initEvosearch({ task: { id: "", prompt: "x", check: "npm test", band: "dev" } }), /id/)
    assert.throws(() => initEvosearch({ task: { id: "t", prompt: " ", check: "npm test", band: "dev" } }), /prompt/)
    assert.throws(() => initEvosearch({ task: { id: "t", prompt: "x", check: "rm -rf /", band: "dev" } }), /whitelist/)
    assert.throws(() => initEvosearch({ task: { id: "t", prompt: "x", check: "npm test", band: "qa" as never } }), /band/)
  })

  it("respects MOMO_ASPIRE_EVO_K default", () => {
    useHome()
    const saved = process.env.MOMO_ASPIRE_EVO_K
    process.env.MOMO_ASPIRE_EVO_K = "4"
    try {
      const state: EvoState = initEvosearch({ task: TASK })
      assert.strictEqual(state.k, 4)
    } finally {
      if (saved === undefined) delete process.env.MOMO_ASPIRE_EVO_K
      else process.env.MOMO_ASPIRE_EVO_K = saved
    }
  })
})
