import { describe, it, afterEach } from "node:test"
import assert from "node:assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { resolveSttConfig, transcribeAudio } from "../voice/stt"
import { defaultRecorderPath } from "../voice/record"

describe("voice/stt", () => {
  const keys = [
    "MOMO_STT_API_KEY",
    "MOMO_OPENAI_API_KEY",
    "MOMO_API_KEY",
    "MOMO_STT_BASE_URL",
    "MOMO_STT_MODEL",
  ]
  afterEach(() => {
    for (const k of keys) delete process.env[k]
  })

  it("resolveSttConfig returns null without keys", () => {
    assert.strictEqual(resolveSttConfig(), null)
  })

  it("resolveSttConfig prefers STT-specific settings", () => {
    process.env.MOMO_API_KEY = "generic"
    process.env.MOMO_STT_API_KEY = "stt-key"
    process.env.MOMO_STT_BASE_URL = "https://api.groq.com/openai/v1"
    process.env.MOMO_STT_MODEL = "whisper-large-v3"
    const cfg = resolveSttConfig()
    assert.strictEqual(cfg?.apiKey, "stt-key")
    assert.strictEqual(cfg?.baseUrl, "https://api.groq.com/openai/v1")
    assert.strictEqual(cfg?.model, "whisper-large-v3")
  })

  it("resolveSttConfig falls back to the generic key with OpenAI defaults", () => {
    process.env.MOMO_API_KEY = "generic"
    const cfg = resolveSttConfig()
    assert.strictEqual(cfg?.apiKey, "generic")
    assert.strictEqual(cfg?.baseUrl, "https://api.openai.com/v1")
    assert.strictEqual(cfg?.model, "whisper-1")
  })

  it("transcribeAudio posts multipart form and returns text", async () => {
    const wav = path.join(os.tmpdir(), `voice-test-${Date.now()}.wav`)
    fs.writeFileSync(wav, Buffer.from("RIFFfake-wav-data"))
    try {
      let capturedUrl = ""
      let capturedAuth = ""
      let hadFile = false
      const fetchImpl = (async (url: unknown, init: { headers?: Record<string, string>; body?: FormData }) => {
        capturedUrl = String(url)
        capturedAuth = init.headers?.Authorization ?? ""
        hadFile = init.body instanceof FormData && init.body.has("file") && init.body.has("model")
        return new Response(JSON.stringify({ text: "  hello world  " }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }) as unknown as typeof fetch

      const text = await transcribeAudio(wav, {
        config: { baseUrl: "https://stt.example/v1", apiKey: "k", model: "m" },
        fetchImpl,
      })
      assert.strictEqual(text, "hello world")
      assert.strictEqual(capturedUrl, "https://stt.example/v1/audio/transcriptions")
      assert.strictEqual(capturedAuth, "Bearer k")
      assert.ok(hadFile)
    } finally {
      fs.rmSync(wav, { force: true })
    }
  })

  it("transcribeAudio throws actionable error without config", async () => {
    await assert.rejects(
      () => transcribeAudio("/nonexistent.wav"),
      /no STT API key/,
    )
  })

  it("transcribeAudio throws on missing file", async () => {
    await assert.rejects(
      () =>
        transcribeAudio("/nonexistent.wav", {
          config: { baseUrl: "https://x/v1", apiKey: "k", model: "m" },
        }),
      /not found/,
    )
  })

  it("transcribeAudio surfaces HTTP errors", async () => {
    const wav = path.join(os.tmpdir(), `voice-test-err-${Date.now()}.wav`)
    fs.writeFileSync(wav, Buffer.from("x"))
    try {
      const fetchImpl = (async () =>
        new Response("bad key", { status: 401 })) as unknown as typeof fetch
      await assert.rejects(
        () =>
          transcribeAudio(wav, {
            config: { baseUrl: "https://x/v1", apiKey: "k", model: "m" },
            fetchImpl,
          }),
        /STT HTTP 401/,
      )
    } finally {
      fs.rmSync(wav, { force: true })
    }
  })
})

describe("voice/record", () => {
  it("bundled recorder script exists", () => {
    const p = defaultRecorderPath()
    assert.ok(p.endsWith(path.join("voice", "record.py")))
    assert.ok(fs.existsSync(p), `recorder should exist at ${p}`)
  })
})
