import { describe, it } from "node:test"
import assert from "node:assert"
import { Effect, ConfigProvider, Layer } from "effect"
import { Trainer, TrainerLive, serializeDataset } from "../evolve/trainer"
import type { TrainingSample, TrainingHparams, LearningStrategy } from "../evolve"

const makeSample = (overrides: Partial<TrainingSample> = {}): TrainingSample => ({
  id: "s-1",
  context: "Fix the bug",
  action: "edit",
  expected: "const x = 1",
  verdict: "pass",
  source: "session-1",
  _tag: "gold",
  ...overrides,
})

const hparams: TrainingHparams = {
  baseModel: "gpt-4o-mini",
  loraRank: 16,
  learningRate: 2e-4,
  batchSize: 4,
  epochs: 3,
  systemPrompt: "You are a helpful coding assistant.",
}

const strategy: LearningStrategy = {
  format: "direct",
  teacherModel: "gpt-4.1",
  evalMethod: "pass@1",
}

const driverLayer = (driver: string) =>
  Layer.setConfigProvider(
    ConfigProvider.fromMap(new Map([["MOMO_EVOLVE_DRIVER", driver]])),
  )

describe("trainer", () => {
  describe("launch", () => {
    it("creates a running training job with local driver", async () => {
      const program = Effect.gen(function* () {
        const trainer = yield* Trainer
        const job = yield* trainer.launch([makeSample()], hparams, strategy)
        return job
      }).pipe(Effect.provide(TrainerLive))

      const job = await Effect.runPromise(program)
      assert.equal(job.status, "running")
      assert.equal(job.datasetSize, 1)
      assert.equal(job.hparams.baseModel, "gpt-4o-mini")
      assert.ok(job.modelId.includes("@ft-"))
    })

    it("dispatches to tinker driver", async () => {
      const program = Effect.gen(function* () {
        const trainer = yield* Trainer
        const job = yield* trainer.launch([makeSample()], hparams, strategy)
        return job
      }).pipe(Effect.provide(TrainerLive), Effect.provide(driverLayer("tinker")))

      const job = await Effect.runPromise(program)
      assert.equal(job.status, "running")
      assert.ok(job.logs?.some((l) => l.includes("[Tinker]")))
    })

    it("dispatches to felix driver", async () => {
      const program = Effect.gen(function* () {
        const trainer = yield* Trainer
        const job = yield* trainer.launch([makeSample()], hparams, strategy)
        return job
      }).pipe(Effect.provide(TrainerLive), Effect.provide(driverLayer("felix")))

      const job = await Effect.runPromise(program)
      assert.equal(job.status, "running")
      assert.ok(job.logs?.some((l) => l.includes("[Felix]")))
    })

    it("tracks launched jobs", async () => {
      const program = Effect.gen(function* () {
        const trainer = yield* Trainer
        const job = yield* trainer.launch([makeSample(), makeSample()], hparams, strategy)
        const status = yield* trainer.status(job.id)
        const jobs = yield* trainer.list()
        return { job, status, jobs }
      }).pipe(Effect.provide(TrainerLive))

      const { job, status, jobs } = await Effect.runPromise(program)
      assert.equal(status._tag, "Some")
      if (status._tag === "Some") {
        assert.equal(status.value.id, job.id)
      }
      assert.equal(jobs.length, 1)
    })
  })

  describe("status", () => {
    it("returns none for a missing job", async () => {
      const program = Effect.gen(function* () {
        const trainer = yield* Trainer
        return yield* trainer.status("does-not-exist")
      }).pipe(Effect.provide(TrainerLive))

      const status = await Effect.runPromise(program)
      assert.equal(status._tag, "None")
    })
  })

  describe("drivers", () => {
    it("logs CoT format when strategy uses cot", async () => {
      const cotStrategy: LearningStrategy = { ...strategy, format: "cot" }
      const program = Effect.gen(function* () {
        const trainer = yield* Trainer
        return yield* trainer.launch([makeSample({ cot: "think" })], hparams, cotStrategy)
      }).pipe(Effect.provide(TrainerLive))

      const job = await Effect.runPromise(program)
      assert.ok(job.logs?.some((l) => l.includes("CoT annotation enabled")))
    })
  })

  describe("serializeDataset", () => {
    it("serializes direct-format samples", () => {
      const samples = [makeSample({ context: "hello", expected: "world" })]
      const jsonl = serializeDataset(samples, "direct")
      const parsed = JSON.parse(jsonl)
      assert.equal(parsed.messages[0].role, "system")
      assert.equal(parsed.messages[1].content, "hello")
      assert.equal(parsed.messages[2].content, "world")
    })

    it("serializes CoT samples with reasoning", () => {
      const samples = [
        makeSample({
          context: "hello",
          expected: "world",
          cot: "think step by step",
        }),
      ]
      const jsonl = serializeDataset(samples, "cot")
      const parsed = JSON.parse(jsonl)
      assert.ok(parsed.messages[2].content.includes("<think>"))
      assert.ok(parsed.messages[2].content.includes("think step by step"))
      assert.ok(parsed.messages[2].content.includes("world"))
    })

    it("falls back to direct format when CoT is missing", () => {
      const samples = [makeSample({ context: "hello", expected: "world" })]
      const jsonl = serializeDataset(samples, "cot")
      const parsed = JSON.parse(jsonl)
      assert.equal(parsed.messages[2].content, "world")
      assert.ok(!parsed.messages[2].content.includes("<think>"))
    })
  })
})
