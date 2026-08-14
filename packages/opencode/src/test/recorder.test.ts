import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  recordSession,
  readRecentSessions,
  getSessionsDir,
} from "../session/recorder"

describe("session/recorder", () => {
  let tmpDir: string
  let savedConfigDir: string | undefined

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-recorder-"))
    savedConfigDir = process.env.MOMO_CONFIG_DIR
    process.env.MOMO_CONFIG_DIR = tmpDir
  })

  after(() => {
    if (savedConfigDir === undefined) delete process.env.MOMO_CONFIG_DIR
    else process.env.MOMO_CONFIG_DIR = savedConfigDir
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("records a session and reads it back", async () => {
    const rec = await recordSession({
      provider: "openai",
      model: "gpt-4.1",
      prompt: "hello world",
      response: "hi there",
      exitCode: 0,
      durationMs: 123,
      rlmDepth: 0,
    })
    assert.ok(rec, "record should be created")
    assert.ok(rec.id.startsWith("ses_"))

    const sessions = readRecentSessions(10)
    assert.strictEqual(sessions.length, 1)
    assert.strictEqual(sessions[0].prompt, "hello world")
    assert.strictEqual(sessions[0].response, "hi there")
    assert.strictEqual(sessions[0].exitCode, 0)
  })

  it("returns newest records up to the limit", async () => {
    for (let i = 0; i < 5; i++) {
      await recordSession({
        provider: "openai",
        model: "gpt-4.1",
        prompt: `prompt ${i}`,
        response: `response ${i}`,
        exitCode: 0,
        durationMs: 1,
        rlmDepth: 0,
      })
    }
    const sessions = readRecentSessions(3)
    assert.strictEqual(sessions.length, 3)
    // chronological order, newest last
    assert.strictEqual(sessions[2].prompt, "prompt 4")
  })

  it("scrubs secrets from recorded content", async () => {
    const rec = await recordSession({
      provider: "openai",
      model: "gpt-4.1",
      prompt: "use key sk-abcdefghijklmnopqrstuvwxyz123456",
      response: "your token is sk-abcdefghijklmnopqrstuvwxyz123456",
      exitCode: 0,
      durationMs: 1,
      rlmDepth: 0,
    })
    assert.ok(rec)
    assert.ok(!rec.response.includes("sk-abcdefghijklmnopqrstuvwxyz"))
  })

  it("truncates very long responses", async () => {
    const rec = await recordSession({
      provider: "openai",
      model: "gpt-4.1",
      prompt: "p",
      response: "x".repeat(20_000),
      exitCode: 0,
      durationMs: 1,
      rlmDepth: 0,
    })
    assert.ok(rec)
    assert.ok(rec.response.length <= 8192)
  })

  it("respects MOMO_SESSION_RECORD=false", async () => {
    process.env.MOMO_SESSION_RECORD = "false"
    try {
      const rec = await recordSession({
        provider: "openai",
        model: "gpt-4.1",
        prompt: "p",
        response: "r",
        exitCode: 0,
        durationMs: 1,
        rlmDepth: 0,
      })
      assert.strictEqual(rec, null)
    } finally {
      delete process.env.MOMO_SESSION_RECORD
    }
  })

  it("readRecentSessions returns [] when no sessions exist", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "momo-empty-"))
    const saved = process.env.MOMO_CONFIG_DIR
    process.env.MOMO_CONFIG_DIR = empty
    try {
      assert.deepStrictEqual(readRecentSessions(5), [])
      assert.ok(getSessionsDir().includes(empty))
    } finally {
      if (saved === undefined) delete process.env.MOMO_CONFIG_DIR
      else process.env.MOMO_CONFIG_DIR = saved
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })
})
