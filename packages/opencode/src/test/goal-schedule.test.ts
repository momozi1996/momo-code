import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  addGoal,
  findGoal,
  loadGoals,
  removeGoal,
  updateGoal,
  activeGoalsBlock,
} from "../goal/store"
import {
  addScheduleEntry,
  dueEntries,
  isDue,
  loadSchedule,
  markRan,
  removeScheduleEntry,
} from "../schedule/store"

describe("goal/store", () => {
  let tmpDir: string
  let saved: string | undefined

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-goal-"))
    saved = process.env.MOMO_CONFIG_DIR
    process.env.MOMO_CONFIG_DIR = tmpDir
  })

  after(() => {
    if (saved === undefined) delete process.env.MOMO_CONFIG_DIR
    else process.env.MOMO_CONFIG_DIR = saved
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("adds and lists goals", () => {
    const g = addGoal("Ship v2", "with full test coverage")
    assert.ok(g.id.startsWith("goal_"))
    assert.strictEqual(g.status, "active")
    assert.strictEqual(loadGoals().length, 1)
    assert.strictEqual(loadGoals()[0].detail, "with full test coverage")
  })

  it("finds goals by id prefix", () => {
    const g = loadGoals()[0]
    assert.strictEqual(findGoal(g.id.slice(0, 10))?.id, g.id)
    assert.strictEqual(findGoal("goal_nonexistent"), null)
  })

  it("logs progress and completes goals", () => {
    const g = loadGoals()[0]
    updateGoal(g.id, (goal) => {
      goal.log.push({ ts: new Date().toISOString(), note: "halfway there" })
    })
    assert.strictEqual(findGoal(g.id)?.log.length, 2)

    updateGoal(g.id, (goal) => {
      goal.status = "done"
    })
    assert.strictEqual(findGoal(g.id)?.status, "done")
  })

  it("activeGoalsBlock excludes done goals", () => {
    addGoal("Still active")
    const block = activeGoalsBlock()
    assert.ok(block.includes("Persistent Goals"))
    assert.ok(block.includes("Still active"))
    assert.ok(!block.includes("Ship v2"))
  })

  it("removes goals", () => {
    const g = addGoal("Temporary")
    assert.ok(removeGoal(g.id))
    assert.strictEqual(findGoal(g.id), null)
    assert.ok(!removeGoal("goal_nonexistent"))
  })
})

describe("schedule/store", () => {
  let tmpDir: string
  let saved: string | undefined

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-sched-"))
    saved = process.env.MOMO_CONFIG_DIR
    process.env.MOMO_CONFIG_DIR = tmpDir
  })

  after(() => {
    if (saved === undefined) delete process.env.MOMO_CONFIG_DIR
    else process.env.MOMO_CONFIG_DIR = saved
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("adds interval entries", () => {
    const e = addScheduleEntry("check tests", { intervalMin: 60 })
    assert.ok(e.id.startsWith("sch_"))
    assert.strictEqual(e.intervalMin, 60)
    assert.strictEqual(e.enabled, true)
    assert.strictEqual(loadSchedule().length, 1)
  })

  it("interval entry with no lastRun is due", () => {
    const entries = dueEntries()
    assert.strictEqual(entries.length, 1)
  })

  it("markRan makes fresh interval entry not due", () => {
    const e = loadSchedule()[0]
    markRan(e.id)
    assert.strictEqual(dueEntries().length, 0)
    // still due when enough time has passed
    const fake = new Date(Date.now() + 61 * 60_000)
    assert.ok(isDue(loadSchedule()[0], fake))
  })

  it("dailyAt entry is due after the time passes", () => {
    // "00:00" has always already passed today (unless run exactly at midnight)
    const e = addScheduleEntry("daily standup", { dailyAt: "00:00" })
    assert.ok(isDue(e))
    // after marking ran, not due again today
    markRan(e.id)
    assert.ok(!isDue(loadSchedule().find((x) => x.id === e.id)!))
  })

  it("disabled entries are never due", () => {
    const entries = loadSchedule()
    entries[0].enabled = false
    const e = { ...entries[0], lastRunAt: undefined }
    assert.ok(!isDue(e))
  })

  it("removes entries", () => {
    const e = loadSchedule()[0]
    assert.ok(removeScheduleEntry(e.id))
    assert.ok(!removeScheduleEntry("sch_nonexistent"))
  })
})
