import { describe, it } from "node:test"
import assert from "node:assert"
import { Effect, Option } from "effect"
import { Registry, RegistryLive } from "../evolve/registry"

describe("registry", () => {
  it("stages a new model version", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* Registry
      yield* registry.stage("momo-coder@ft-20260615-abc")
      const versions = yield* registry.list()
      return versions
    }).pipe(Effect.provide(RegistryLive))

    const versions = await Effect.runPromise(program)
    assert.equal(versions.length, 1)
    assert.equal(versions[0].id, "momo-coder@ft-20260615-abc")
    assert.equal(versions[0].status, "staged")
  })

  it("promotes staged to production and archives previous", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* Registry
      yield* registry.stage("momo-coder@ft-v1")
      yield* registry.promote("momo-coder@ft-v1")
      yield* registry.stage("momo-coder@ft-v2")
      yield* registry.promote("momo-coder@ft-v2")
      return yield* registry.list()
    }).pipe(Effect.provide(RegistryLive))

    const versions = await Effect.runPromise(program)
    assert.equal(versions.length, 2)
    const v1 = versions.find((v) => v.id === "momo-coder@ft-v1")!
    const v2 = versions.find((v) => v.id === "momo-coder@ft-v2")!
    assert.equal(v1.status, "archived")
    assert.equal(v2.status, "production")
    assert.ok(v2.promotedAt)
  })

  it("rolls back to the most recent archived version", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* Registry
      yield* registry.stage("momo-coder@ft-v1")
      yield* registry.promote("momo-coder@ft-v1")
      yield* registry.stage("momo-coder@ft-v2")
      yield* registry.promote("momo-coder@ft-v2")
      yield* registry.rollback()
      return yield* registry.list()
    }).pipe(Effect.provide(RegistryLive))

    const versions = await Effect.runPromise(program)
    const v1 = versions.find((v) => v.id === "momo-coder@ft-v1")!
    const v2 = versions.find((v) => v.id === "momo-coder@ft-v2")!
    assert.equal(v1.status, "production")
    assert.equal(v2.status, "archived")
  })

  it("does nothing when rolling back without archived versions", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* Registry
      yield* registry.rollback()
      return yield* registry.list()
    }).pipe(Effect.provide(RegistryLive))

    const versions = await Effect.runPromise(program)
    assert.equal(versions.length, 0)
  })

  it("marks a version as failed", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* Registry
      yield* registry.stage("momo-coder@ft-bad")
      yield* registry.markFailed("momo-coder@ft-bad")
      return yield* registry.list()
    }).pipe(Effect.provide(RegistryLive))

    const versions = await Effect.runPromise(program)
    assert.equal(versions[0].status, "failed")
  })

  it("returns current production model", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* Registry
      yield* registry.stage("momo-coder@ft-prod")
      yield* registry.promote("momo-coder@ft-prod")
      return yield* registry.current()
    }).pipe(Effect.provide(RegistryLive))

    const current = await Effect.runPromise(program)
    assert.equal(current._tag, "Some")
    if (current._tag === "Some") {
      assert.equal(current.value.id, "momo-coder@ft-prod")
    }
  })

  it("returns none when no production model exists", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* Registry
      yield* registry.stage("momo-coder@ft-staged")
      return yield* registry.current()
    }).pipe(Effect.provide(RegistryLive))

    const current = await Effect.runPromise(program)
    assert.equal(current._tag, "None")
  })

  it("returns the most recent archived version", async () => {
    const program = Effect.gen(function* () {
      const registry = yield* Registry
      yield* registry.stage("momo-coder@ft-v1")
      yield* registry.promote("momo-coder@ft-v1")
      yield* registry.stage("momo-coder@ft-v2")
      yield* registry.promote("momo-coder@ft-v2")
      return yield* registry.lastArchived()
    }).pipe(Effect.provide(RegistryLive))

    const archived = await Effect.runPromise(program)
    assert.equal(archived._tag, "Some")
    if (archived._tag === "Some") {
      assert.equal(archived.value.id, "momo-coder@ft-v1")
    }
  })
})
