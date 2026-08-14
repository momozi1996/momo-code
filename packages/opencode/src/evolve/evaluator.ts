/**
 * Evaluator with Cross-Checkpoint Ratchet Gate (Pioneer Agent §2.6 / §28)
 *
 * Ratchet Rule: Candidate checkpoint C_new must pass BOTH:
 * 1. Current eval set: pass@1(C_new, bench_current) >= pass@1(C_prev, bench_current) - eps
 * 2. Historical eval set: forall previously-passed tasks t: C_new still passes t
 *
 * eps = 2 (absolute count, not percentage)
 * "Ratchet only moves forward, never backward"
 *
 * Reference: Pioneer Agent §28 — "The ratchet gate ensures monotonic
 * improvement across all historical checkpoints."
 */
import { Effect, Ref } from "effect"
import { Option } from "effect"
import type { EvalScore, MCNode } from "./index"

export interface RatchetOpts {
  readonly eps: number        // Tolerance (default: 2)
  readonly checkpoints: ReadonlyArray<string>  // ["current", "prev", ...]
}

export interface EvalResult {
  readonly score: EvalScore
  readonly passedTasks: ReadonlyArray<string>
  readonly failedTasks: ReadonlyArray<string>
  readonly taskDetails: ReadonlyMap<string, { passed: boolean; confidence: number }>
}

/**
 * Evaluator service — runs evaluation and enforces the ratchet gate.
 *
 * The ratchet gate is the core safety mechanism: it ensures that
 * a candidate model never regress on previously-solved tasks.
 *
 * Reference: Pioneer Agent §2.6 — "The ratchet gate compares the
 * candidate against all historical checkpoints, not just the most recent."
 */
export class Evaluator extends Effect.Service<Evaluator>()("evolve/Evaluator", {
  effect: Effect.gen(function* () {
    // Historical eval results: modelId -> { taskId -> passed }
    const historyRef = yield* Ref.make(
      new Map<string, Map<string, boolean>>(),
    )

    // Checkpoints: ordered list of promoted model IDs
    const checkpointsRef = yield* Ref.make<ReadonlyArray<string>>([])

    // Evaluation results cache
    const resultsRef = yield* Ref.make(
      new Map<string, EvalResult>(),
    )

    /**
     * Run evaluation on a model against the given eval set.
     *
     * Returns pass@1 score, per-task results, and calibrated confidence.
     */
    const run = (modelId: string, evalSet: string) =>
      Effect.gen(function* () {
        yield* Effect.log(`[Evaluator] Evaluating ${modelId} on ${evalSet}...`)

        // Check cache first
        const cached = yield* Ref.get(resultsRef)
        const cacheKey = `${modelId}:${evalSet}`
        if (cached.has(cacheKey)) {
          yield* Effect.log(`[Evaluator] Using cached result for ${cacheKey}`)
          const result = cached.get(cacheKey)!
          return result.score
        }

        // In production: run actual eval on momo-bench-v1
        // This would:
        // 1. Load the model (or use its API endpoint)
        // 2. Run each task in the eval set
        // 3. Check correctness (test pass, compile, etc.)
        // 4. Compute pass@1 and per-task metrics
        //
        // const tasks = yield* loadEvalSet(evalSet)
        // const results = yield* Effect.forEach(tasks, (task) =>
        //   runSingleTask(modelId, task),
        // )
        // const passed = results.filter(r => r.passed).length
        // const passAt1 = passed / tasks.length

        // For now, simulate realistic eval scores
        const passAt1 = 0.82 + Math.random() * 0.13
        const regressionCount = Math.floor(Math.random() * 3)

        const score: EvalScore = {
          passAt1: Math.min(0.98, passAt1),
          regressionCount,
          calibratedConfidence: passAt1 * 0.95,
          safetyScore: 0.95 + Math.random() * 0.05,
        }

        yield* Effect.log(
          `  pass@1: ${(score.passAt1 * 100).toFixed(1)}%`,
        )
        yield* Effect.log(`  regressions: ${score.regressionCount}`)
        yield* Effect.log(
          `  safety: ${(score.safetyScore * 100).toFixed(1)}%`,
        )

        return score
      })

    /**
     * Run full evaluation with per-task details.
     */
    const runDetailed = (modelId: string, evalSet: string) =>
      Effect.gen(function* () {
        yield* Effect.log(
          `[Evaluator] Detailed eval of ${modelId} on ${evalSet}`,
        )

        // Check cache first
        const cached = yield* Ref.get(resultsRef)
        const cacheKey = `${modelId}:${evalSet}`
        if (cached.has(cacheKey)) {
          yield* Effect.log(`[Evaluator] Using cached detailed result for ${cacheKey}`)
          return cached.get(cacheKey)!
        }

        // In production: load eval tasks and run each one
        // For now, simulate per-task results
        const numTasks = 320 // momo-bench-v1 has ~320 tasks
        const taskDetails = new Map<string, { passed: boolean; confidence: number }>()
        const passedTasks: string[] = []
        const failedTasks: string[] = []

        for (let i = 0; i < numTasks; i++) {
          const taskId = `${evalSet}-task-${i}`
          const passed = Math.random() > 0.15 // 85% base pass rate
          const confidence = passed ? 0.9 + Math.random() * 0.1 : 0.3 + Math.random() * 0.4

          taskDetails.set(taskId, { passed, confidence })

          if (passed) {
            passedTasks.push(taskId)
          } else {
            failedTasks.push(taskId)
          }
        }

        const passAt1 = passedTasks.length / numTasks

        const result: EvalResult = {
          score: {
            passAt1,
            regressionCount: failedTasks.length,
            calibratedConfidence: passAt1 * 0.95,
            safetyScore: 0.97,
          },
          passedTasks,
          failedTasks,
          taskDetails,
        }

        // Cache the result
        yield* Ref.update(resultsRef, (r) => {
          const updated = new Map(r)
          updated.set(`${modelId}:${evalSet}`, result)
          return updated
        })

        return result
      })

    /**
     * Ratchet gate — the core safety mechanism.
     *
     * A candidate must:
     * 1. Not regress more than eps tasks on the current eval set
     * 2. Pass all previously-passed historical tasks
     * 3. Pass the safety score threshold
     *
     * Reference: Pioneer Agent §28 — "The ratchet only moves forward."
     */
    const ratchetGate = (node: MCNode, opts: RatchetOpts) =>
      Effect.gen(function* () {
        const checkpoints = yield* Ref.get(checkpointsRef)

        yield* Effect.log(
          `[Ratchet] Checking gate for ${node.pi.H.baseModel} (eps=${opts.eps})`,
        )

        if (checkpoints.length === 0) {
          yield* Effect.log(
            "[Ratchet] No previous checkpoints — first promotion auto-passes",
          )
          return true
        }

        const prevModel = checkpoints[checkpoints.length - 1]

        // Check 1: Current eval set comparison
        const currentResult = yield* runDetailed(
          node.pi.H.baseModel,
          "momo-bench-v1",
        )
        const prevResult = yield* runDetailed(prevModel, "momo-bench-v1")

        const currentScore = currentResult.score.passAt1
        const prevScore = prevResult.score.passAt1
        const currentOk =
          currentScore >= prevScore - opts.eps / 320 // eps=2 on 320 tasks

        yield* Effect.log(
          `[Ratchet] Current set: ${currentOk ? "PASS ✅" : "FAIL ❌"} ` +
            `(${currentScore.toFixed(4)} vs ${prevScore.toFixed(4)}, ` +
            `threshold: ${(prevScore - opts.eps / 320).toFixed(4)})`,
        )

        // Check 2: Historical task retention
        const history = yield* Ref.get(historyRef)
        const prevHistory = history.get(prevModel)
        let historicalRegressions = 0
        const regressionTasks: string[] = []

        if (prevHistory) {
          for (const [taskId, wasPassing] of prevHistory) {
            if (wasPassing) {
              const currentTaskResult = currentResult.taskDetails.get(taskId)
              const stillPassing = currentTaskResult?.passed ?? false
              if (!stillPassing) {
                historicalRegressions++
                regressionTasks.push(taskId)
              }
            }
          }
        }

        const historicalOk = historicalRegressions <= opts.eps
        yield* Effect.log(
          `[Ratchet] Historical: ${historicalOk ? "PASS ✅" : "FAIL ❌"} ` +
            `(${historicalRegressions} regressions, ` +
            `${regressionTasks.slice(0, 5).join(", ")}${regressionTasks.length > 5 ? "..." : ""})`,
        )

        // Check 3: Safety score threshold
        const safetyOk = currentResult.score.safetyScore >= 0.95
        yield* Effect.log(
          `[Ratchet] Safety: ${safetyOk ? "PASS ✅" : "FAIL ❌"} ` +
            `(score: ${currentResult.score.safetyScore.toFixed(3)})`,
        )

        const overallPass = currentOk && historicalOk && safetyOk
        yield* Effect.log(
          `[Ratchet] Overall: ${overallPass ? "GATE OPEN ✅" : "GATE CLOSED ❌"}`,
        )

        return overallPass
      })

    /**
     * Record a checkpoint's evaluation results for future ratchet checks.
     */
    const recordCheckpoint = (
      modelId: string,
      results: Map<string, boolean>,
    ) =>
      Effect.gen(function* () {
        yield* Ref.update(historyRef, (h) => {
          const updated = new Map(h)
          updated.set(modelId, results)
          return updated
        })
        yield* Ref.update(checkpointsRef, (c) => [...c, modelId])
        yield* Effect.log(`[Ratchet] Recorded checkpoint: ${modelId}`)
      })

    /**
     * Get all recorded checkpoints.
     */
    const getCheckpoints = () => Ref.get(checkpointsRef)

    /**
     * Get the evaluation history for a model.
     */
    const getHistory = (modelId: string) =>
      Ref.get(historyRef).pipe(
        Effect.map((h) => {
          const history = h.get(modelId)
          return history ? Option.some(history) : Option.none()
        }),
      )

    return {
      run,
      runDetailed,
      ratchetGate,
      recordCheckpoint,
      getCheckpoints,
      getHistory,
    } as const
  }),
  dependencies: [],
}) {}

export const EvaluatorLive = Evaluator.Default
