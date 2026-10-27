import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createServer } from "node:http"
import fs from "fs"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"

const execute = promisify(execFile)
const packageDir = fileURLToPath(new URL("../../", import.meta.url))
let tmp: string
let configDir: string
type Message = { role: string; content: string | Array<{ text?: string }> | null }
const textOf = (message: Message) => typeof message.content === "string" ? message.content :
  message.content?.map((part) => part.text ?? "").join("") ?? ""
const requests: Array<{ model: string; messages: Message[]; stream: boolean }> = []
const server = createServer(async (req, res) => {
  let body = ""
  for await (const chunk of req) body += chunk
  const payload = JSON.parse(body)
  requests.push(payload)
  if (payload.messages.some((message: Message) => textOf(message) === "FAIL_HTTP_FIXTURE")) {
    res.writeHead(400, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: { message: "offline fixture failure" } }))
    return
  }
  res.writeHead(200, { "Content-Type": "text/event-stream" })
  const chunk = (delta: object, finish_reason: string | null) => JSON.stringify({
    id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture",
    choices: [{ index: 0, delta, finish_reason }],
  })
  if (payload.messages.some((message: Message) => textOf(message) === "TRY_WRITE_FIXTURE") &&
      !payload.messages.some((message: Message) => message.role === "tool")) {
    res.write(`data: ${chunk({ tool_calls: [{
      index: 0, id: "fixture-write", type: "function",
      function: { name: "write", arguments: JSON.stringify({ path: path.join(tmp, "owned.txt"), content: "fixture" }) },
    }] }, null)}\n\n`)
    res.write(`data: ${chunk({}, "tool_calls")}\n\n`)
    res.end("data: [DONE]\n\n")
    return
  }
  res.write(`data: ${chunk({ role: "assistant", content: "OFFLINE_OK" }, null)}\n\n`)
  res.write(`data: ${chunk({}, "stop")}\n\n`)
  res.end("data: [DONE]\n\n")
})

function childEnv() {
  return {
    PATH: process.env.PATH,
    HOME: tmp,
    TMPDIR: os.tmpdir(),
    MOMO_CONFIG_DIR: configDir,
    MOMO_NO_CC_SWITCH: "true",
    MOMO_CC_SWITCH_INHERIT: "false",
    // Keep the developer machine's momo.jsonc from overwriting fixture files.
    MOMO_PI_CONFIG_SYNC: "false",
    // Never let the Hy-Memory integration bootstrap a Python venv in tests.
    MOMO_MEMORY: "0",
    PI_OFFLINE: "1",
  }
}

before(async () => {
  // These tests drive `bin/momo`, whose Pi runtime loads from dist/. Without a
  // prior `npm run build` the CLI silently degrades to the native REPL and
  // every lifecycle assertion below fails with opaque "Missing expected
  // rejection" errors — fail fast with the actionable message instead.
  if (!fs.existsSync(path.join(packageDir, "dist", "pi-runtime.js"))) {
    assert.fail(
      "dist/pi-runtime.js not found — run `npm run build` before the pi-cli tests",
    )
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momo-pi-cli-"))
  configDir = path.join(tmp, ".momo")
  fs.mkdirSync(configDir)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  fs.writeFileSync(path.join(configDir, "models.json"), JSON.stringify({
    providers: {
      offlinefixture: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "fixture-key",
        models: [{ id: "fixture", reasoning: false, contextWindow: 32768, maxTokens: 512 }],
      },
    },
  }))
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify({
    defaultProvider: "offlinefixture", defaultModel: "fixture", defaultThinkingLevel: "off",
    retry: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: "off",
  }))
})

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("bin/momo with the installed Pi SDK and an offline provider", () => {
  for (const args of [["exec", "fixture prompt"], ["fixture prompt"]]) {
    it(`completes ${args[0]} through the real print lifecycle`, async () => {
      const { stdout, stderr } = await execute(process.execPath, ["bin/momo", ...args], {
        cwd: packageDir, env: childEnv(), timeout: 20_000,
      })
      assert.strictEqual(stdout.trim(), "OFFLINE_OK")
      assert.ok(!stderr.includes("Tactic injection failed"), stderr)
      assert.strictEqual(requests.at(-1)?.model, "fixture")
      assert.strictEqual(requests.at(-1)?.stream, true)
      assert.ok(requests.at(-1)?.messages.some((message) => textOf(message) === "fixture prompt"))
      assert.ok(fs.existsSync(path.join(configDir, "rsi-metrics.jsonl")))
    })
  }

  it("emits parseable JSON events through the real JSON lifecycle", async () => {
    const { stdout } = await execute(process.execPath, ["bin/momo", "--json", "fixture prompt"], {
      cwd: packageDir, env: childEnv(), timeout: 20_000,
    })
    const events = stdout.trim().split("\n").map((line) => JSON.parse(line))
    assert.ok(events.some((event) => JSON.stringify(event).includes("OFFLINE_OK")))
    assert.ok(events.some((event) => event.type === "agent_end" || event.type === "agent_settled"))
  })

  it("blocks an unapproved write through the SDK's actual tool dispatch", async () => {
    const { stdout } = await execute(process.execPath, ["bin/momo", "exec", "TRY_WRITE_FIXTURE"], {
      cwd: packageDir, env: childEnv(), timeout: 20_000,
    })
    assert.strictEqual(stdout.trim(), "OFFLINE_OK")
    assert.ok(!fs.existsSync(path.join(tmp, "owned.txt")))
    assert.ok(requests.at(-1)?.messages.some((message) =>
      message.role === "tool" && textOf(message).includes("interactive approval")))
  })

  for (const mode of ["exec", "--json"]) {
    it(`returns a failing exit code when the provider rejects a ${mode} request`, async () => {
      await assert.rejects(execute(process.execPath, ["bin/momo", mode, "FAIL_HTTP_FIXTURE"], {
        cwd: packageDir, env: childEnv(), timeout: 20_000,
      }), (error: Error & { code?: number; stderr?: string; stdout?: string }) => {
        assert.strictEqual(error.code, 1)
        assert.ok(`${error.stderr ?? ""}${error.stdout ?? ""}`.includes("offline fixture failure"))
        return true
      })
    })
  }
})
