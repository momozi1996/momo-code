/**
 * SimBridge — NDJSON JSON-RPC client for the genesis_world server.
 *
 * Owns a persistent Python child process running
 * `python/genesis_world/server.py`. Requests are newline-delimited JSON;
 * protocol lines are prefixed with @@RPC@@ so Genesis/engine logs can
 * share stdout without corrupting framing.
 *
 * @module sim/bridge
 */

import { spawn, type ChildProcess } from "child_process"
import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeRequestOpts {
  /** Per-request timeout in ms (default: 120_000) */
  readonly timeoutMs?: number
}

export interface SimBridgeOpts {
  /** Python executable (default: MOMO_SIM_PYTHON or "python") */
  readonly python?: string
  /** Server script path (default: bundled genesis_world/server.py) */
  readonly serverPath?: string
  /** Extra env for the child */
  readonly env?: Record<string, string>
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

// -- Workbench types ----------------------------------------------------------

export interface SimClock {
  readonly t: number
  readonly steps: number
  readonly playing: boolean
  readonly speed: number
  readonly dt?: number
}

export interface SceneEntity {
  readonly idx: number
  readonly name: string
  readonly type: string
  readonly pos: number[]
  readonly quat: number[]
  readonly link_count: number
}

export interface SceneInfo {
  readonly entities: SceneEntity[]
  readonly is_built: boolean
  readonly dt: number
  readonly clock: SimClock
}

export interface ScenePose {
  readonly node: string
  readonly pos: number[]
  readonly quat: number[]
}

export interface PreviewResult {
  readonly ok: boolean
  readonly error?: string
  readonly entities?: SceneEntity[]
  readonly cameras?: string[]
  readonly export?: { glb: string; manifest: string; nodes: number; skipped: number }
  readonly clock?: SimClock
  readonly errors?: string[]
}

export interface CameraSpec {
  readonly name: string
  readonly pos?: number[]
  readonly lookat?: number[]
  readonly fov?: number
  readonly res?: number[]
  readonly external?: boolean
}

export interface CameraKeyframe {
  readonly t: number
  readonly pos: number[]
  readonly lookat: number[]
}

export interface CameraAddSpec {
  readonly name: string
  readonly pos?: number[]
  readonly lookat?: number[]
  readonly fov?: number
  readonly res?: number[]
}

const RPC_PREFIX = "@@RPC@@"
const LOG_PREFIX = "@@LOG@@"

// ---------------------------------------------------------------------------
// SimBridge
// ---------------------------------------------------------------------------

export class SimBridge {
  private child: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private buffer = ""
  private closed = false

  /** Lines logged by the world server (@@LOG@@ / non-protocol output). */
  readonly serverLog: string[] = []

  constructor(private readonly opts: SimBridgeOpts = {}) {}

  /** Default path of the bundled world server. */
  static defaultServerPath(): string {
    const here = path.dirname(fileURLToPath(import.meta.url))
    // src/sim/ → ../../python/genesis_world/server.py (works from src and dist)
    return path.resolve(here, "..", "..", "python", "genesis_world", "server.py")
  }

  /**
   * Resolve the interpreter command for the world server.
   *
   * Order: explicit MOMO_SIM_PYTHON / opts.python → `uv run --project <python/>`
   * when the world directory is a uv project (MOMO_SIM_UV=0 disables) →
   * plain `python`.
   */
  resolvePythonCommand(serverPath: string): { cmd: string; args: string[] } {
    const explicit = this.opts.python || process.env.MOMO_SIM_PYTHON
    if (explicit) return { cmd: explicit, args: ["-u", serverPath] }
    if (process.env.MOMO_SIM_UV !== "0") {
      const pythonDir = path.resolve(path.dirname(serverPath), "..")
      try {
        if (fs.existsSync(path.join(pythonDir, "pyproject.toml"))) {
          return {
            cmd: "uv",
            args: ["run", "--project", pythonDir, "python", "-u", serverPath],
          }
        }
      } catch {
        // fall through to plain python
      }
    }
    return { cmd: "python", args: ["-u", serverPath] }
  }

  /** Spawn the world server process. Idempotent. */
  start(): void {
    if (this.child) return
    const serverPath =
      this.opts.serverPath ||
      process.env.MOMO_SIM_SERVER ||
      SimBridge.defaultServerPath()
    const { cmd, args } = this.resolvePythonCommand(serverPath)

    this.child = spawn(cmd, args, {
      env: { ...process.env, ...this.opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })

    this.child.stdout?.on("data", (d: Buffer) => this.onData(d.toString()))
    this.child.stderr?.on("data", (d: Buffer) => {
      this.serverLog.push(`[stderr] ${d.toString().trim()}`)
    })
    this.child.on("error", (err) => this.failAll(new Error(`spawn failed: ${err.message}`)))
    this.child.on("close", (code) => {
      this.failAll(new Error(`world server exited (code ${code})`))
      this.child = null
      // A crashed world loses its persistent namespace — fail fast
      // instead of silently restarting with an empty world.
      this.closed = true
    })
  }

  /** Send a JSON-RPC request and await its result. Throws on server errors. */
  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts: BridgeRequestOpts = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("bridge is closed"))
    this.start()
    if (!this.child?.stdin) {
      return Promise.reject(new Error("world server stdin unavailable"))
    }

    const id = this.nextId++
    const timeoutMs = opts.timeoutMs ?? 120_000

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`request '${method}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      })

      this.child!.stdin!.write(JSON.stringify({ id, method, params }) + "\n")
    })
  }

  // -- Convenience wrappers --------------------------------------------------

  ping() {
    return this.request<{ pong: boolean; initialized: boolean }>("ping")
  }

  initWorld(params: { viewer?: boolean; backend?: string } = {}) {
    return this.request<{
      initialized: boolean
      backend: string
      genesis_version: string
      skills_loaded: Array<{ file: string; status: string; error?: string }>
    }>("init", params, { timeoutMs: 300_000 }) // Genesis init is slow on CPU
  }

  exec(code: string, timeoutMs = 300_000) {
    return this.request<{ stdout: string; stderr: string; error?: string }>(
      "exec",
      { code },
      { timeoutMs },
    )
  }

  evalExpr(expr: string) {
    return this.request<{ repr?: string; error?: string }>("eval", { expr })
  }

  observe() {
    return this.request<{ observation: unknown; source: string; error?: string }>(
      "observe",
    )
  }

  // -- Workbench wrappers (time / scene / camera) ----------------------------

  timeControl(action: "play" | "pause" | "step" | "speed", opts: { n?: number; speed?: number } = {}) {
    return this.request<SimClock>(`time/${action}`, { ...opts })
  }

  timeStatus() {
    return this.request<SimClock>("time/status")
  }

  sceneInfo() {
    return this.request<SceneInfo>("scene/info")
  }

  scenePoses() {
    return this.request<{ poses: ScenePose[]; clock: SimClock }>("scene/poses")
  }

  sceneExport() {
    return this.request<{ glb: string; manifest: string; nodes: number; skipped: number }>(
      "scene/export",
      {},
      { timeoutMs: 300_000 },
    )
  }

  scenePreview(code: string) {
    return this.request<PreviewResult>("scene/preview", { code }, { timeoutMs: 300_000 })
  }

  sceneRebuild(params: { viewer?: boolean; backend?: string } = {}) {
    return this.request<{ initialized: boolean; backend: string }>(
      "scene/rebuild",
      params,
      { timeoutMs: 300_000 },
    )
  }

  cameraList() {
    return this.request<{ cameras: CameraSpec[] }>("camera/list")
  }

  cameraAdd(spec: CameraAddSpec) {
    return this.request<{ added: string }>("camera/add", { ...spec })
  }

  cameraRemove(name: string) {
    return this.request<{ removed: string }>("camera/remove", { name })
  }

  cameraMove(name: string, pose: { pos?: number[]; lookat?: number[] }) {
    return this.request<{ moved: string }>("camera/move", { name, ...pose })
  }

  cameraSnapshot(name: string) {
    return this.request<{ rgb?: string; depth?: string }>(
      "camera/snapshot",
      { name },
      { timeoutMs: 120_000 },
    )
  }

  /** Register a {t, pos, lookat} keyframe trajectory for a camera. */
  cameraPathSet(name: string, keyframes: CameraKeyframe[]) {
    return this.request<{ path: string; keyframes: number }>("camera/path/set", {
      name,
      keyframes,
    })
  }

  cameraPathClear(name: string) {
    return this.request<{ cleared: string }>("camera/path/clear", { name })
  }

  cameraPathList() {
    return this.request<{ paths: Record<string, CameraKeyframe[]> }>("camera/path/list")
  }

  /** Shut down the server and release resources. */
  async close(): Promise<void> {
    if (this.closed) return
    try {
      if (this.child) {
        await this.request("shutdown", {}, { timeoutMs: 5_000 }).catch(() => {})
      }
    } finally {
      this.closed = true
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error("bridge closed"))
      }
      this.pending.clear()
      try {
        this.child?.kill()
      } catch {
        /* already dead */
      }
      this.child = null
    }
  }

  // -- Framing ---------------------------------------------------------------

  private onData(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      if (line.startsWith(RPC_PREFIX)) {
        this.onMessage(line.slice(RPC_PREFIX.length))
      } else {
        this.serverLog.push(
          line.startsWith(LOG_PREFIX) ? line.slice(LOG_PREFIX.length) : line,
        )
      }
    }
  }

  private onMessage(json: string): void {
    let msg: { id?: number | null; ok?: boolean; result?: unknown; error?: string }
    try {
      msg = JSON.parse(json)
    } catch {
      this.serverLog.push(`[protocol] unparseable line: ${json.slice(0, 200)}`)
      return
    }
    if (msg.id == null) return // server-initiated notification (e.g. shutdown ack)
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    clearTimeout(pending.timer)
    if (msg.ok) pending.resolve(msg.result)
    else pending.reject(new Error(msg.error || "unknown world server error"))
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}
