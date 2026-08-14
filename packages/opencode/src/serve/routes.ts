/**
 * momo serve — GET routes: stateless reads from the ~/.momo stores.
 *
 * @module serve/routes
 */

import { loadGoals } from "../goal/store.js"
import { loadSchedule } from "../schedule/store.js"
import { readRecentSessions, getMomoHome } from "../session/recorder.js"
import { execFile } from "child_process"
import * as fs from "fs"
import * as path from "path"
import type { SimBridge } from "../sim/bridge.js"
import {
  bestTrial,
  listStudies,
  loadStudy,
  readTrials,
} from "../optim/study.js"
import { loadSemantics } from "../optim/semantics.js"
import { listRuns, loadRun } from "../graph/store.js"
import { listSimRuns, loadSimRun } from "../sim/runs.js"
import { ASSET_CATALOG } from "../sim/assets.js"
import type { GraphRun } from "../graph/types.js"
import { isStudyRunning } from "./actions.js"
import { getSimBridge } from "./actions.js"
import { sendError, sendJson, sendFile, openSse, type RouteHandler } from "./server.js"

/** Proxy a bridge call → JSON, or 503 when the sim world is unavailable. */
async function proxySim(
  res: import("http").ServerResponse,
  fn: (b: SimBridge) => Promise<unknown>,
): Promise<void> {
  try {
    const bridge = await getSimBridge()
    sendJson(res, 200, await fn(bridge))
  } catch (err) {
    sendError(res, 503, `sim world unavailable: ${err instanceof Error ? err.message : err}`)
  }
}

// ---------------------------------------------------------------------------
// Optim helpers
// ---------------------------------------------------------------------------

function graphRunSummary(run: GraphRun) {
  return {
    id: run.id,
    task: run.task,
    status: run.status,
    maxNodes: run.maxNodes,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    nodeCount: run.nodes.length,
    done: run.nodes.filter((n) => n.state === "done").length,
    failed: run.nodes.filter((n) => n.state === "failed" || n.state === "skipped").length,
    waiting: run.nodes.filter((n) => n.state === "waiting").length,
    tokens: run.tokens?.total ?? 0,
    hasOutput: !!run.output,
  }
}

function studySummary(name: string) {
  const config = loadStudy(name)
  if (!config) return null
  const trials = readTrials(name)
  const best = bestTrial(config.direction, trials)
  const semantics = loadSemantics(name)
  return {
    name: config.name,
    direction: config.direction,
    metric: config.metric,
    trials: trials.length,
    completed: trials.filter((t) => t.state === "complete").length,
    semantics: semantics?.status ?? "none",
    running: isStudyRunning(name),
    best: best ? { number: best.number, value: best.value, params: best.params } : null,
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Live stream snapshot (global SSE feed for the dashboard)
// ---------------------------------------------------------------------------

function streamSnapshot() {
  const runs = listRuns().map(graphRunSummary)
  const sessions = readRecentSessions(10)
  const studies = listStudies().map(studySummary).filter((x): x is NonNullable<typeof x> => x !== null)
  const goals = loadGoals()
  const sched = loadSchedule()
  const running = runs.filter(
    (r) => r.status === "planned" || r.status === "running" || r.status === "waiting",
  )
  return {
    t: new Date().toISOString(),
    graph: {
      runs,
      active: running.length,
      nodeProgress: running.map((r) => ({
        id: r.id,
        done: r.done,
        failed: r.failed,
        total: r.nodeCount,
      })),
    },
    sessions: {
      items: sessions,
      latestTs: sessions[0]?.ts ?? null,
    },
    studies: {
      items: studies,
      running: studies.filter((s) => s.running).length,
    },
    goals: { active: goals.filter((g) => g.status === "active").length },
    schedule: { enabled: sched.filter((e) => e.enabled).length },
    sim: simSnapshotPart(),
  }
}
function simSnapshotPart() {
  const simRuns = listSimRuns(5)
  return {
    items: simRuns,
    active: simRuns.filter((r) => r.status === "running").length,
    latestTs: simRuns[0]?.updatedAt ?? null,
  }
}

// ---------------------------------------------------------------------------
// Git helpers (read-only status/diff for the workspace panel)
// ---------------------------------------------------------------------------

function findGitRoot(start: string = process.cwd()): string | null {
  let dir = start
  for (let i = 0; i < 10; i++) {
    try {
      if (fs.existsSync(path.join(dir, ".git"))) return dir
    } catch {
      return null
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

async function gitRun(
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const root = findGitRoot()
  if (!root) return { ok: false, stdout: "", stderr: "not a git repository" }
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", root, ...args],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 15_000, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout ?? "",
          stderr: (stderr ?? "") || (err instanceof Error ? err.message : String(err)),
        })
      },
    )
  })
}

function parseStatusPorcelain(text: string) {
  const changes: Array<{
    path: string
    index: string
    worktree: string
    staged: boolean
  }> = []
  let branch = "?"
  let upstream: string | undefined
  let ahead = 0
  let behind = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    if (line.startsWith("## ")) {
      const m = line
        .slice(3)
        .trim()
        .match(/^(\S+?)(?:\.\.\.(\S+?))?(?:\s+\[([^\]]+)\])?$/)
      if (m) {
        branch = m[1]
        upstream = m[2]
        const meta = m[3] ?? ""
        const a = meta.match(/ahead (\d+)/)
        const b = meta.match(/behind (\d+)/)
        if (a) ahead = Number(a[1])
        if (b) behind = Number(b[1])
      }
      continue
    }
    if (line.length < 4) continue
    const index = line[0]
    const worktree = line[1]
    let p = line.slice(3)
    const arrow = p.indexOf(" -> ")
    if (arrow !== -1) p = p.slice(arrow + 4) // renames: keep the new path
    p = p.replace(/^"|"$/g, "").replace(/\\"/g, '"')
    changes.push({ path: p, index, worktree, staged: index !== " " && index !== "?" && index !== "!" })
  }
  return { branch, upstream, ahead, behind, changes }
}

async function gitStatus() {
  const root = findGitRoot()
  if (!root) return null
  const status = await gitRun(["status", "--porcelain=v1", "--branch", "--untracked-files=normal"])
  const log = await gitRun(["log", "-8", "--pretty=format:%h%x09%ad%x09%s", "--date=short"])
  if (!status.ok) return { root, error: status.stderr }
  const parsed = parseStatusPorcelain(status.stdout)
  const commits = log.ok
    ? log.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => {
          const [hash, date, ...rest] = l.split("\t")
          return { hash, date: date ?? "", subject: rest.join("\t") }
        })
    : []
  return { root, ...parsed, commits }
}

function safeGitPath(root: string, rel: string): string | null {
  if (
    !rel ||
    rel.includes("..") ||
    rel.includes(":") ||
    rel.startsWith("/") ||
    rel.startsWith("\\")
  ) {
    return null
  }
  const resolved = path.resolve(root, rel)
  if (!resolved.startsWith(path.resolve(root))) return null
  return resolved
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function getRoutes(): Record<string, RouteHandler> {
  return {
    "/api/sessions": ({ res, query }) => {
      const limit = Math.min(Number(query.get("limit")) || 50, 500)
      sendJson(res, 200, { sessions: readRecentSessions(limit) })
    },

    "/api/stream": ({ req, res }) => {
      const push = openSse(res)
      let last = ""
      const tick = () => {
        try {
          const snap = streamSnapshot()
          // exclude the wall-clock field from the diff key, otherwise every
          // tick looks "changed" and the client gets full snapshots non-stop
          const { t: _t, ...rest } = snap
          const key = JSON.stringify(rest)
          if (key !== last) {
            last = key
            push("snapshot", snap)
          } else {
            push("ping", { t: Date.now() })
          }
        } catch {
          push("ping", { t: Date.now() })
        }
      }
      tick()
      const timer = setInterval(tick, 2000)
      req.on("close", () => clearInterval(timer))
    },

    "/api/git/status": async ({ res }) => {
      const info = await gitStatus()
      if (!info) sendError(res, 404, "not a git repository")
      else sendJson(res, 200, info)
    },

    "/api/git/diff": async ({ res, query }) => {
      const root = findGitRoot()
      if (!root) {
        sendError(res, 404, "not a git repository")
        return
      }
      const rel = query.get("path") ?? ""
      if (!safeGitPath(root, rel)) {
        sendError(res, 400, "invalid path")
        return
      }
      const [work, staged] = await Promise.all([
        gitRun(["diff", "--", rel]),
        gitRun(["diff", "--cached", "--", rel]),
      ])
      sendJson(res, 200, { path: rel, diff: [staged.stdout, work.stdout].filter(Boolean).join("\n") })
    },
    "/api/graph/runs": ({ res }) => {
      const runs = listRuns().map(graphRunSummary)
      sendJson(res, 200, { runs })
    },

    "/api/graph/runs/:id": ({ res, params }) => {
      const run = loadRun(params.id)
      if (!run) {
        sendError(res, 404, `graph run "${params.id}" not found`)
        return
      }
      sendJson(res, 200, run)
    },

    "/api/optim/studies": ({ res }) => {
      const studies = listStudies()
        .map(studySummary)
        .filter(Boolean)
      sendJson(res, 200, { studies })
    },

    "/api/optim/studies/:name": ({ res, params }) => {
      const config = loadStudy(params.name)
      if (!config) {
        sendError(res, 404, `study "${params.name}" not found`)
        return
      }
      const trials = readTrials(params.name)
      const best = bestTrial(config.direction, trials)
      const semantics = loadSemantics(params.name)
      sendJson(res, 200, {
        ...config,
        running: isStudyRunning(params.name),
        semantics: semantics
          ? { status: semantics.status, params: semantics.params, interactions: semantics.interactions, constraints: semantics.constraints }
          : null,
        best: best ? { number: best.number, value: best.value, params: best.params } : null,
      })
    },

    "/api/optim/studies/:name/trials": ({ res, params }) => {
      if (!loadStudy(params.name)) {
        sendError(res, 404, `study "${params.name}" not found`)
        return
      }
      sendJson(res, 200, { trials: readTrials(params.name) })
    },

    "/api/optim/studies/:name/stream": ({ req, res, params }) => {
      if (!loadStudy(params.name)) {
        sendError(res, 404, `study "${params.name}" not found`)
        return
      }
      const push = openSse(res)
      let seen = readTrials(params.name).length
      let lastRunning = isStudyRunning(params.name)
      push("status", { running: lastRunning, trials: seen })

      const timer = setInterval(() => {
        try {
          const trials = readTrials(params.name)
          for (let i = seen; i < trials.length; i++) {
            push("trial", trials[i])
          }
          seen = trials.length
          const running = isStudyRunning(params.name)
          if (running !== lastRunning) {
            lastRunning = running
            push("status", { running, trials: seen })
          }
        } catch {
          // keep the stream alive across transient read errors
        }
      }, 2000)

      req.on("close", () => clearInterval(timer))
    },

    "/api/goals": ({ res }) => {
      sendJson(res, 200, { goals: loadGoals() })
    },

    "/api/schedule": ({ res }) => {
      sendJson(res, 200, { entries: loadSchedule() })
    },

    "/api/sim/observe": async ({ res }) => {
      try {
        const bridge = await getSimBridge()
        const estop = await bridge.evalExpr("ESTOP")
        const obs = await bridge.observe()
        sendJson(res, 200, { estop: estop.repr === "True", observation: obs })
      } catch (err) {
        sendError(
          res,
          503,
          `sim world unavailable: ${err instanceof Error ? err.message : err}`,
        )
      }
    },

    // -- Sim workbench (time / scene / camera) -------------------------------

    "/api/sim/scene/info": async ({ res }) => {
      await proxySim(res, (b) => b.sceneInfo())
    },

    "/api/sim/scene/poses": async ({ res }) => {
      await proxySim(res, (b) => b.scenePoses())
    },

    "/api/sim/scene/mesh": ({ res }) => {
      const dir = path.join(getMomoHome(), "sim", "preview")
      sendFile(res, dir, "scene.glb", "model/gltf-binary")
    },

    "/api/sim/cameras": async ({ res }) => {
      await proxySim(res, (b) => b.cameraList())
    },

    "/api/sim/camera-paths": async ({ res }) => {
      await proxySim(res, (b) => b.cameraPathList())
    },

    "/api/sim/assets": ({ res }) => {
      sendJson(res, 200, { assets: ASSET_CATALOG })
    },

    "/api/sim/runs": ({ res, query }) => {
      const limit = Math.min(Number(query.get("limit")) || 20, 100)
      sendJson(res, 200, { runs: listSimRuns(limit) })
    },

    "/api/sim/runs/:id": ({ res, params }) => {
      const run = loadSimRun(params.id)
      if (!run) {
        sendError(res, 404, `sim run "${params.id}" not found`)
        return
      }
      sendJson(res, 200, run)
    },

    "/api/sim/frames/:file": ({ res, params }) => {
      const dir = path.join(getMomoHome(), "sim", "frames")
      sendFile(res, dir, params.file, "image/png")
    },

    "/api/sim/poses/stream": async ({ req, res }) => {
      let bridge
      try {
        bridge = await getSimBridge()
      } catch (err) {
        sendError(res, 503, `sim world unavailable: ${err instanceof Error ? err.message : err}`)
        return
      }
      const push = openSse(res)
      let lastClock = ""
      const timer = setInterval(async () => {
        try {
          const data = await bridge.scenePoses()
          push("pose", data.poses)
          const clock = JSON.stringify(data.clock)
          if (clock !== lastClock) {
            lastClock = clock
            push("clock", data.clock)
          }
        } catch {
          // keep the stream alive across transient bridge errors
        }
      }, 200) // ~5Hz
      req.on("close", () => clearInterval(timer))
    },
  }
}
