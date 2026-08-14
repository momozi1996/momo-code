import { describe, it } from "node:test"
import assert from "node:assert"
import * as path from "path"
import * as os from "os"
import * as fs from "fs"
import { SimBridge } from "../sim/bridge"

/**
 * These tests use a tiny fake Python server that echoes NDJSON RPC
 * traffic — no Genesis dependency, fast enough for the quality wall.
 */

const FAKE_SERVER = `
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    if req.get("method") == "explode":
        sys.exit(3)
    if req.get("method") == "hang":
        import time; time.sleep(30)
    if req.get("method") == "shutdown":
        print("@@RPC@@" + json.dumps({"id": None, "ok": True, "result": {"bye": True}}), flush=True)
        sys.exit(0)
    print("@@LOG@@some engine noise", flush=True)
    print("@@RPC@@" + json.dumps({"id": req.get("id"), "ok": True, "result": {"echo": req.get("params", {}), "method": req.get("method")}}), flush=True)
`

function withFakeServer(fn: (bridge: SimBridge) => Promise<void>): () => Promise<void> {
  return async () => {
    const tmp = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "momo-simtest-")),
      "fake_server.py",
    )
    fs.writeFileSync(tmp, FAKE_SERVER, "utf-8")
    const bridge = new SimBridge({ serverPath: tmp })
    try {
      await fn(bridge)
    } finally {
      await bridge.close()
      fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
    }
  }
}

describe("sim/bridge", () => {
  it(
    "round-trips a request and captures server logs",
    withFakeServer(async (bridge) => {
      const result = await bridge.request<{ echo: { x: number }; method: string }>(
        "ping",
        { x: 1 },
      )
      assert.strictEqual(result.method, "ping")
      assert.strictEqual(result.echo.x, 1)
      assert.ok(bridge.serverLog.some((l) => l.includes("engine noise")))
    }),
  )

  it(
    "pairs concurrent requests by id",
    withFakeServer(async (bridge) => {
      const [a, b] = await Promise.all([
        bridge.request<{ echo: { n: number } }>("m", { n: 1 }),
        bridge.request<{ echo: { n: number } }>("m", { n: 2 }),
      ])
      assert.strictEqual(a.echo.n, 1)
      assert.strictEqual(b.echo.n, 2)
    }),
  )

  it(
    "times out hanging requests",
    withFakeServer(async (bridge) => {
      await assert.rejects(
        () => bridge.request("hang", {}, { timeoutMs: 500 }),
        /timed out/,
      )
    }),
  )

  it(
    "rejects pending requests when the server crashes",
    withFakeServer(async (bridge) => {
      await assert.rejects(() => bridge.request("explode"), /exited|closed|failed/)
      // subsequent requests fail fast too
      await assert.rejects(
        () => bridge.request("ping", {}, { timeoutMs: 3000 }),
        /exited|closed|failed|unavailable/,
      )
    }),
  )

  it("default server path points at the bundled genesis_world server", () => {
    const p = SimBridge.defaultServerPath()
    assert.ok(p.endsWith(path.join("genesis_world", "server.py")))
    assert.ok(fs.existsSync(p), `bundled server should exist at ${p}`)
  })

  it(
    "workbench wrappers send the expected method/params",
    withFakeServer(async (bridge) => {
      // fake server echoes {method, echo: params} for every request
      const play = await bridge.timeControl("play")
      assert.strictEqual((play as any).method, "time/play")

      const step = await bridge.timeControl("step", { n: 5 })
      assert.strictEqual((step as any).method, "time/step")
      assert.strictEqual((step as any).echo.n, 5)

      const speed = await bridge.timeControl("speed", { speed: 2 })
      assert.strictEqual((speed as any).echo.speed, 2)

      assert.strictEqual((await bridge.timeStatus() as any).method, "time/status")
      assert.strictEqual((await bridge.sceneInfo() as any).method, "scene/info")
      assert.strictEqual((await bridge.scenePoses() as any).method, "scene/poses")
      assert.strictEqual((await bridge.sceneExport() as any).method, "scene/export")

      const preview = await bridge.scenePreview("scene.add_entity(gs.morphs.Plane())")
      assert.strictEqual((preview as any).method, "scene/preview")
      assert.ok((preview as any).echo.code.includes("Plane"))

      assert.strictEqual((await bridge.sceneRebuild() as any).method, "scene/rebuild")

      const add = await bridge.cameraAdd({ name: "front", pos: [1, 0, 1], lookat: [0, 0, 0.3] })
      assert.strictEqual((add as any).method, "camera/add")
      assert.deepStrictEqual((add as any).echo.pos, [1, 0, 1])

      assert.strictEqual((await bridge.cameraList() as any).method, "camera/list")
      assert.strictEqual((await bridge.cameraRemove("front") as any).method, "camera/remove")
      assert.strictEqual(
        ((await bridge.cameraMove("front", { pos: [2, 0, 1] })) as any).method,
        "camera/move",
      )
      assert.strictEqual((await bridge.cameraSnapshot("front") as any).method, "camera/snapshot")
    }),
  )
})
