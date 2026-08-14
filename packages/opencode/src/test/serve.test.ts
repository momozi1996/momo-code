import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as http from "http"
import { createServeApp, type ServeApp } from "../serve/server"
import { createStudy, appendTrial } from "../optim/study"

// ---------------------------------------------------------------------------
// Isolation + fixtures
// ---------------------------------------------------------------------------

let tmp: string
let saved: string | undefined
let app: ServeApp

function seedFixtures(dir: string): void {
  // sessions
  const sessionsDir = path.join(dir, "sessions")
  fs.mkdirSync(sessionsDir, { recursive: true })
  fs.writeFileSync(
    path.join(sessionsDir, "2026-08-10.jsonl"),
    JSON.stringify({
      id: "ses_test1", ts: "2026-08-10T08:00:00.000Z", provider: "optim",
      model: "mock-sampler", prompt: "[optim] demo", response: "BEST: 0.5",
      exitCode: 0, durationMs: 100, rlmDepth: 0,
    }) + "\n",
    "utf-8",
  )
  // goals
  fs.writeFileSync(
    path.join(dir, "goals.json"),
    JSON.stringify({ goals: [{ id: "goal_1", title: "Ship it", status: "active", createdAt: "2026-08-01T00:00:00.000Z" }] }),
    "utf-8",
  )
  // schedule
  fs.writeFileSync(
    path.join(dir, "schedule.json"),
    JSON.stringify({ entries: [{ id: "sch_1", prompt: "heartbeat", intervalMin: 60, enabled: true, createdAt: "2026-08-01T00:00:00.000Z" }] }),
    "utf-8",
  )
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<{ status: number; data: any }> {
  const r = await fetch(url, opts)
  const data = await r.json().catch(() => ({}))
  return { status: r.status, data }
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "momo-serve-"))
  saved = process.env.MOMO_CONFIG_DIR
  process.env.MOMO_CONFIG_DIR = tmp
  seedFixtures(tmp)
  createStudy({
    name: "svc",
    direction: "maximize",
    space: [{ name: "x", type: "float", low: 0, high: 1 }],
    metric: "metric",
    evaluator: { kind: "cmd", cmd: "echo metric=0.5" },
  })
  app = await createServeApp({ port: 0 })
})

after(async () => {
  await app.close()
  if (saved === undefined) delete process.env.MOMO_CONFIG_DIR
  else process.env.MOMO_CONFIG_DIR = saved
  fs.rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// GET endpoints
// ---------------------------------------------------------------------------

describe("serve GET endpoints", () => {
  it("GET / returns the dashboard HTML", async () => {
    const r = await fetch(`${app.url}/`)
    const html = await r.text()
    assert.strictEqual(r.status, 200)
    assert.match(html, /<title>momo workspace<\/title>/)
  })

  it("GET /api/health", async () => {
    const { status, data } = await fetchJson(`${app.url}/api/health`)
    assert.strictEqual(status, 200)
    assert.strictEqual(data.ok, true)
    assert.ok(data.momoHome.includes("momo-serve-"))
  })

  it("GET /api/sessions returns seeded records", async () => {
    const { status, data } = await fetchJson(`${app.url}/api/sessions`)
    assert.strictEqual(status, 200)
    assert.strictEqual(data.sessions.length, 1)
    assert.strictEqual(data.sessions[0].provider, "optim")
  })

  it("GET /api/optim/studies lists the study with summary", async () => {
    const { status, data } = await fetchJson(`${app.url}/api/optim/studies`)
    assert.strictEqual(status, 200)
    assert.strictEqual(data.studies.length, 1)
    assert.strictEqual(data.studies[0].name, "svc")
    assert.strictEqual(data.studies[0].running, false)
  })

  it("GET /api/optim/studies/:name and /trials", async () => {
    const detail = await fetchJson(`${app.url}/api/optim/studies/svc`)
    assert.strictEqual(detail.status, 200)
    assert.strictEqual(detail.data.metric, "metric")
    const trials = await fetchJson(`${app.url}/api/optim/studies/svc/trials`)
    assert.strictEqual(trials.status, 200)
    assert.deepStrictEqual(trials.data.trials, [])
    const missing = await fetchJson(`${app.url}/api/optim/studies/nope`)
    assert.strictEqual(missing.status, 404)
  })

  it("GET /api/goals and /api/schedule", async () => {
    const goals = await fetchJson(`${app.url}/api/goals`)
    assert.strictEqual(goals.data.goals[0].title, "Ship it")
    const sched = await fetchJson(`${app.url}/api/schedule`)
    assert.strictEqual(sched.data.entries[0].id, "sch_1")
  })

  it("unknown route returns 404 JSON", async () => {
    const { status, data } = await fetchJson(`${app.url}/api/nope`)
    assert.strictEqual(status, 404)
    assert.ok(data.error)
  })
})

// ---------------------------------------------------------------------------
// POST actions
// ---------------------------------------------------------------------------

describe("serve POST actions", () => {
  it("POST run starts a mock run; concurrent run gets 409; trials land", async () => {
    const body = JSON.stringify({ trials: 3, mock: true })
    const first = await fetchJson(`${app.url}/api/optim/studies/svc/run`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    })
    assert.strictEqual(first.status, 202)
    assert.strictEqual(first.data.started, true)

    // The lock is held from the moment the 202 is sent
    const second = await fetchJson(`${app.url}/api/optim/studies/svc/run`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    })
    assert.strictEqual(second.status, 409)

    // Wait for the run to finish (3 echo trials — fast)
    for (let i = 0; i < 50; i++) {
      const { data } = await fetchJson(`${app.url}/api/optim/studies/svc/trials`)
      if (data.trials.length >= 3) {
        assert.ok(data.trials.every((t: any) => t.state === "complete"))
        assert.strictEqual(data.trials[0].value, 0.5)
        return
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    assert.fail("run did not complete in time")
  })

  it("POST run on missing study returns 404", async () => {
    const { status } = await fetchJson(`${app.url}/api/optim/studies/nope/run`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    })
    assert.strictEqual(status, 404)
  })

  it("POST chat validates the body", async () => {
    const { status, data } = await fetchJson(`${app.url}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    })
    assert.strictEqual(status, 400)
    assert.match(data.error, /prompt/)
  })

  it("POST sim/estop responds with JSON (world up or 503) and never crashes", async () => {
    // Point the bridge at a nonexistent python so spawn fails fast (ENOENT
    // → failAll) instead of launching a real Genesis world during tests.
    const savedPy = process.env.MOMO_SIM_PYTHON
    process.env.MOMO_SIM_PYTHON = "python-definitely-missing-optim-test"
    try {
      const { status, data } = await fetchJson(`${app.url}/api/sim/estop`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      })
      assert.ok([200, 503].includes(status), `unexpected status ${status}`)
      if (status === 503) assert.ok(data.error)
    } finally {
      if (savedPy === undefined) delete process.env.MOMO_SIM_PYTHON
      else process.env.MOMO_SIM_PYTHON = savedPy
    }
  })
})

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

describe("serve SSE stream", () => {
  it("pushes appended trials as event:trial frames", async () => {
    const stream = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SSE timeout")), 8000)
      const req = http.get(`${app.url}/api/optim/studies/svc/stream`, (res) => {
        let buf = ""
        res.on("data", (chunk) => {
          buf += chunk.toString()
          if (buf.includes("event: trial")) {
            clearTimeout(timer)
            req.destroy()
            resolve(buf)
          }
        })
      })
      req.on("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
      // Append a trial after the stream is up (poll interval is 2s)
      setTimeout(() => {
        appendTrial("svc", {
          number: 99, params: { x: 0.1 }, state: "complete",
          ts: new Date().toISOString(), value: 0.5,
        })
      }, 500)
    })
    assert.match(stream, /event: trial/)
    assert.match(stream, /"number":99/)
  })
})

// ---------------------------------------------------------------------------
// Sim workbench endpoints (fake world server via MOMO_SIM_SERVER)
// ---------------------------------------------------------------------------

const FAKE_WORKBENCH_SERVER = `
import sys, json
CLOCK = {"t": 0.0, "steps": 0, "playing": True, "speed": 1.0, "dt": 0.01}
RESP = {
  "init": {"initialized": True, "backend": "cpu", "genesis_version": "0.0.0", "skills_loaded": []},
  "ping": {"pong": True, "initialized": True},
  "scene/info": {"entities": [{"idx": 0, "name": "plane", "type": "RigidEntity", "pos": [0,0,0], "quat": [1,0,0,0], "link_count": 1}], "is_built": True, "dt": 0.01, "clock": CLOCK},
  "scene/poses": {"poses": [{"node": "e0", "pos": [0,0,0], "quat": [1,0,0,0]}]},
  "scene/preview": {"ok": True, "entities": [], "cameras": ["front"], "errors": []},
  "camera/list": {"cameras": [{"name": "front"}]},
  "camera/add": {"name": "cam1"},
  "camera/remove": {"removed": "cam1"},
  "camera/snapshot": {"rgb": "C:/tmp/sim/frames/frame_front.png"},
  "time/play": {"clock": CLOCK},
  "time/pause": {"clock": CLOCK},
  "time/step": {"clock": CLOCK},
  "time/speed": {"clock": CLOCK},
  "time/status": {"clock": CLOCK},
  "shutdown": {"bye": True},
}
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    if req.get("method") == "shutdown":
        print("@@RPC@@" + json.dumps({"id": req.get("id"), "ok": True, "result": {"bye": True}}), flush=True)
        sys.exit(0)
    result = RESP.get(req.get("method", ""), {"echo": req.get("params", {}), "method": req.get("method", "")})
    print("@@RPC@@" + json.dumps({"id": req.get("id"), "ok": True, "result": result}), flush=True)
`

describe("serve sim workbench endpoints", () => {
  let savedServer: string | undefined
  let fakePath: string

  before(async () => {
    savedServer = process.env.MOMO_SIM_SERVER
    fakePath = path.join(tmp, "fake_workbench_server.py")
    fs.writeFileSync(fakePath, FAKE_WORKBENCH_SERVER, "utf-8")
    process.env.MOMO_SIM_SERVER = fakePath
    // Seed a frame + glb for the static file endpoints
    const framesDir = path.join(tmp, "sim", "frames")
    fs.mkdirSync(framesDir, { recursive: true })
    fs.writeFileSync(path.join(framesDir, "frame_test.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const previewDir = path.join(tmp, "sim", "preview")
    fs.mkdirSync(previewDir, { recursive: true })
    fs.writeFileSync(path.join(previewDir, "scene.glb"), Buffer.from("glTF-fake"))
  })

  after(async () => {
    const { closeSimBridge } = await import("../serve/actions")
    await closeSimBridge()
    if (savedServer === undefined) delete process.env.MOMO_SIM_SERVER
    else process.env.MOMO_SIM_SERVER = savedServer
  })

  it("GET /workbench serves the workbench HTML", async () => {
    const r = await fetch(`${app.url}/workbench`)
    const html = await r.text()
    assert.strictEqual(r.status, 200)
    assert.match(html, /<title>momo sim workbench<\/title>/)
  })

  it("GET /api/sim/scene/info and /poses proxy the world", async () => {
    const info = await fetchJson(`${app.url}/api/sim/scene/info`)
    assert.strictEqual(info.status, 200)
    assert.strictEqual(info.data.entities[0].name, "plane")
    assert.strictEqual(info.data.is_built, true)
    const poses = await fetchJson(`${app.url}/api/sim/scene/poses`)
    assert.strictEqual(poses.status, 200)
    assert.strictEqual(poses.data.poses[0].node, "e0")
  })

  it("GET /api/sim/cameras lists cameras", async () => {
    const { status, data } = await fetchJson(`${app.url}/api/sim/cameras`)
    assert.strictEqual(status, 200)
    assert.strictEqual(data.cameras[0].name, "front")
  })

  it("POST /api/sim/time play/speed/bad-action", async () => {
    const play = await fetchJson(`${app.url}/api/sim/time`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "play" }),
    })
    assert.strictEqual(play.status, 200)
    assert.strictEqual(play.data.clock.playing, true)
    const speed = await fetchJson(`${app.url}/api/sim/time`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "speed", speed: 4 }),
    })
    assert.strictEqual(speed.status, 200)
    const bad = await fetchJson(`${app.url}/api/sim/time`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rewind" }),
    })
    assert.strictEqual(bad.status, 400)
  })

  it("POST /api/sim/preview runs scene code", async () => {
    const { status, data } = await fetchJson(`${app.url}/api/sim/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "scene.add_entity(...)" }),
    })
    assert.strictEqual(status, 200)
    assert.strictEqual(data.ok, true)
    const missing = await fetchJson(`${app.url}/api/sim/preview`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    })
    assert.strictEqual(missing.status, 400)
  })

  it("camera add/remove/snapshot endpoints", async () => {
    const add = await fetchJson(`${app.url}/api/sim/cameras`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "cam1", pos: [1, 0, 1] }),
    })
    assert.strictEqual(add.status, 200)
    assert.strictEqual(add.data.name, "cam1")
    const shot = await fetchJson(`${app.url}/api/sim/cameras/cam1/snapshot`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    })
    assert.strictEqual(shot.status, 200)
    assert.strictEqual(shot.data.url, "/api/sim/frames/frame_front.png")
    const rm = await fetchJson(`${app.url}/api/sim/cameras/cam1/remove`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    })
    assert.strictEqual(rm.status, 200)
  })

  it("POST /api/sim/cameras without a name returns 400", async () => {
    const { status } = await fetchJson(`${app.url}/api/sim/cameras`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    })
    assert.strictEqual(status, 400)
  })

  it("GET /api/sim/frames serves PNGs and blocks traversal", async () => {
    const ok = await fetch(`${app.url}/api/sim/frames/frame_test.png`)
    assert.strictEqual(ok.status, 200)
    assert.strictEqual(ok.headers.get("content-type"), "image/png")
    const missing = await fetch(`${app.url}/api/sim/frames/nope.png`)
    assert.strictEqual(missing.status, 404)
    const traversal = await fetch(`${app.url}/api/sim/frames/..%2Fsecret.json`)
    assert.strictEqual(traversal.status, 403)
  })

  it("GET /api/sim/scene/mesh serves the exported GLB", async () => {
    const r = await fetch(`${app.url}/api/sim/scene/mesh`)
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.headers.get("content-type"), "model/gltf-binary")
    assert.strictEqual(await r.text(), "glTF-fake")
  })

  it("GET /api/sim/poses/stream pushes pose frames over SSE", async () => {
    const stream = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SSE timeout")), 8000)
      const req = http.get(`${app.url}/api/sim/poses/stream`, (res) => {
        let buf = ""
        res.on("data", (chunk) => {
          buf += chunk.toString()
          if (buf.includes("event: pose")) {
            clearTimeout(timer)
            req.destroy()
            resolve(buf)
          }
        })
      })
      req.on("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    assert.match(stream, /event: pose/)
    assert.match(stream, /"node":"e0"/)
  })
})

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("serve auth", () => {
  it("token-protected app rejects wrong/missing tokens", async () => {
    const protected1 = await createServeApp({ port: 0, token: "s3cret" })
    try {
      const noAuth = await fetchJson(`${protected1.url}/api/health`)
      assert.strictEqual(noAuth.status, 401)
      const badAuth = await fetchJson(`${protected1.url}/api/health`, {
        headers: { Authorization: "Bearer wrong" },
      })
      assert.strictEqual(badAuth.status, 401)
      const good = await fetchJson(`${protected1.url}/api/health`, {
        headers: { Authorization: "Bearer s3cret" },
      })
      assert.strictEqual(good.status, 200)
      // ?token= fallback (browser EventSource)
      const viaQuery = await fetchJson(`${protected1.url}/api/health?token=s3cret`)
      assert.strictEqual(viaQuery.status, 200)
    } finally {
      await protected1.close()
    }
  })

  it("refuses non-loopback bind without a token", async () => {
    await assert.rejects(() => createServeApp({ host: "0.0.0.0", port: 0 }), /without a token/)
  })
})
