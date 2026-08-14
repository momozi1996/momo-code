/**
 * momo serve — POST actions: one-shot writes (optim run, sim estop/resume,
 * chat). Runs are async with one lock per study; progress flows over SSE.
 *
 * @module serve/actions
 */

import { chatComplete, resolveProviderConfig } from "../cli/chat.js"
import { SimBridge } from "../sim/bridge.js"
import { MockSampler } from "../optim/sampler.js"
import { runStudy } from "../optim/runner.js"
import { loadSemantics } from "../optim/semantics.js"
import { loadStudy } from "../optim/study.js"
import { approveRun, rejectRun, resumeGraph, runGraph } from "../graph/engine.js"
import { newRunId } from "../graph/store.js"
import { runSimLoop } from "../sim/loop.js"
import { appendSimTurn, createSimRun, finishSimRun, loadSimRun } from "../sim/runs.js"
import { recordSession } from "../session/recorder.js"
import { openSse, sendError, sendJson, type RouteHandler } from "./server.js"

// ---------------------------------------------------------------------------
// Run locking (one concurrent run per study)
// ---------------------------------------------------------------------------

const running = new Set<string>()
const graphRunning = new Set<string>()

export function isStudyRunning(name: string): boolean {
  return running.has(name)
}

export function isGraphRunning(id: string): boolean {
  return graphRunning.has(id)
}

// ---------------------------------------------------------------------------
// Sim bridge (lazy singleton; closed on process exit)
// ---------------------------------------------------------------------------

let bridge: SimBridge | undefined
let bridgeInit: Promise<SimBridge> | undefined

function simSpawnHint(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const low = msg.toLowerCase()
  if (low.includes("eacces") || low.includes("enoent") || low.includes("spawn")) {
    const py = process.env.MOMO_SIM_PYTHON || "python"
    return (
      `${msg} — python interpreter not launchable (currently "${py}"). ` +
      `Install Python 3.10+ with genesis, or set MOMO_SIM_PYTHON to a working ` +
      `python.exe (e.g. a conda env). Run "momo /sim doctor" for a full check.`
    )
  }
  return msg
}

export async function getSimBridge(): Promise<SimBridge> {
  if (bridge) return bridge
  if (!bridgeInit) {
    bridgeInit = (async () => {
      const b = new SimBridge()
      try {
        await b.initWorld({})
      } catch (err) {
        throw new Error(simSpawnHint(err))
      }
      bridge = b
      return b
    })()
    bridgeInit.catch(() => {
      bridgeInit = undefined // allow retry after a failed init
    })
  }
  return bridgeInit
}


// ---------------------------------------------------------------------------
// Chat helpers
// ---------------------------------------------------------------------------

/** Deterministic offline reply used when no LLM provider is configured. */
function mockChatReply(prompt: string): string {
  const p = prompt.length > 160 ? prompt.slice(0, 160) + "…" : prompt
  return [
    `模型服务暂不可用，请稍后重试。`,
    ``,
    `你刚才说：「${p}」`,
  ].join("\n")
}
process.once("exit", () => {
  try {
    if (bridge) void bridge.close()
  } catch {
    // shutting down — ignore
  }
})

/** Close the lazy bridge (tests and graceful shutdown). */
export async function closeSimBridge(): Promise<void> {
  try {
    if (bridge) await bridge.close()
  } finally {
    bridge = undefined
    bridgeInit = undefined
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function getActions(): Record<string, RouteHandler> {
  return {
    "/api/graph/runs": async ({ res, body }) => {
      const payload = (typeof body === "object" && body !== null ? body : {}) as {
        task?: unknown
        maxNodes?: unknown
        maxRetries?: unknown
      }
      const task = typeof payload.task === "string" ? payload.task.trim() : ""
      if (!task) {
        sendError(res, 400, `body must be {"task": "..."}`)
        return
      }
      const maxNodes = Math.min(Math.max(Number(payload.maxNodes) || 12, 1), 50)
      const maxRetries = Math.min(Math.max(Number(payload.maxRetries) || 2, 0), 5)
      const runId = newRunId()

      const startMs = Date.now()
      // Async: the response returns immediately; progress is visible via /api/graph/runs
      void (async () => {
        try {
          const run = await runGraph(task, { id: runId, maxNodes, maxRetries })
          await recordSession({
            provider: "graph",
            model: "graph-engine",
            prompt: `[graph] ${task} (via /serve)`,
            response: `${run.nodes.length} nodes · status=${run.status}\n${run.output ?? ""}`.slice(0, 4000),
            exitCode: run.status === "failed" ? 1 : 0,
            durationMs: Date.now() - startMs,
            rlmDepth: 0,
          })
        } catch {
          // failures surface as the run state in the store
        }
      })()

      sendJson(res, 202, { started: true, id: runId, task, maxNodes, maxRetries })
    },

    "/api/graph/runs/:id/resume": async ({ res, params }) => {
      if (graphRunning.has(params.id)) {
        sendError(res, 409, `graph run "${params.id}" is already resuming`)
        return
      }
      graphRunning.add(params.id)
      const startMs = Date.now()
      void (async () => {
        try {
          const run = await resumeGraph(params.id)
          if (run) {
            await recordSession({
              provider: "graph",
              model: "graph-engine",
              prompt: `[graph resume] ${params.id} (via /serve)`,
              response: `status=${run.status}\n${run.output ?? ""}`.slice(0, 4000),
              exitCode: run.status === "failed" ? 1 : 0,
              durationMs: Date.now() - startMs,
              rlmDepth: 0,
            })
          }
        } catch {
          // failures surface as the run state in the store
        } finally {
          graphRunning.delete(params.id)
        }
      })()

      sendJson(res, 202, { started: true, id: params.id })
    },

    "/api/graph/runs/:id/approve": async ({ res, params }) => {
      if (graphRunning.has(params.id)) {
        sendError(res, 409, `graph run "${params.id}" is already resuming`)
        return
      }
      graphRunning.add(params.id)
      const startMs = Date.now()
      void (async () => {
        try {
          const run = await approveRun(params.id)
          if (run) {
            await recordSession({
              provider: "graph",
              model: "graph-engine",
              prompt: `[graph approve] ${params.id} (via /serve)`,
              response: `status=${run.status}\n${run.output ?? ""}`.slice(0, 4000),
              exitCode: run.status === "failed" ? 1 : 0,
              durationMs: Date.now() - startMs,
              rlmDepth: 0,
            })
          }
        } catch {
          // failures surface as the run state in the store
        } finally {
          graphRunning.delete(params.id)
        }
      })()

      sendJson(res, 202, { started: true, id: params.id })
    },

    "/api/graph/runs/:id/reject": async ({ res, params }) => {
      if (graphRunning.has(params.id)) {
        sendError(res, 409, `graph run "${params.id}" is already resuming`)
        return
      }
      graphRunning.add(params.id)
      const startMs = Date.now()
      void (async () => {
        try {
          const run = await rejectRun(params.id)
          if (run) {
            await recordSession({
              provider: "graph",
              model: "graph-engine",
              prompt: `[graph reject] ${params.id} (via /serve)`,
              response: `status=${run.status}\n${run.output ?? ""}`.slice(0, 4000),
              exitCode: run.status === "failed" ? 1 : 0,
              durationMs: Date.now() - startMs,
              rlmDepth: 0,
            })
          }
        } catch {
          // failures surface as the run state in the store
        } finally {
          graphRunning.delete(params.id)
        }
      })()

      sendJson(res, 202, { started: true, id: params.id })
    },

    "/api/optim/studies/:name/run": async ({ res, params, body }) => {
      const config = loadStudy(params.name)
      if (!config) {
        sendError(res, 404, `study "${params.name}" not found`)
        return
      }
      if (running.has(params.name)) {
        sendError(res, 409, `study "${params.name}" already has a run in progress`)
        return
      }
      const payload = (typeof body === "object" && body !== null ? body : {}) as {
        trials?: unknown
        mock?: unknown
      }
      const trials = Math.min(Math.max(Number(payload.trials) || 10, 1), 1000)
      const useMock = payload.mock === true

      const semantics = loadSemantics(params.name)
      const approved = semantics?.status === "approved" ? semantics : undefined

      running.add(params.name)
      const startMs = Date.now()
      // Async: the response returns immediately; progress flows over SSE.
      void (async () => {
        try {
          const result = await runStudy(config, {
            trials,
            ...(useMock ? { sampler: new MockSampler() } : {}),
            ...(approved ? { semantics: approved } : {}),
          })
          await recordSession({
            provider: "optim",
            model: useMock ? "mock-sampler" : "agent-sampler",
            prompt: `[optim] ${params.name} (via /serve): ${config.direction} ${config.metric} (${trials} trials)`,
            response: result.best
              ? `BEST: ${result.best.value} at ${JSON.stringify(result.best.params)}`
              : `FAILED: no completed trial`,
            exitCode: result.best ? 0 : 1,
            durationMs: Date.now() - startMs,
            rlmDepth: 0,
          })
        } catch {
          // run failures surface via the trials/status SSE feed
        } finally {
          running.delete(params.name)
        }
      })()

      sendJson(res, 202, { started: true, trials, mock: useMock, semantics: approved ? "approved" : "blind" })
    },

    "/api/sim/run": async ({ res, body }) => {
      const payload = (typeof body === "object" && body !== null ? body : {}) as {
        task?: unknown
      }
      const task = typeof payload.task === "string" ? payload.task.trim() : ""
      if (!task) {
        sendError(res, 400, `body must be {"task": "..."}`)
        return
      }
      const run = createSimRun(task)
      const startMs = Date.now()
      // Async: the response returns immediately; turns stream to /api/sim/runs/:id
      void (async () => {
        try {
          const bridge = await getSimBridge()
          const result = await runSimLoop(task, bridge, {
            onTurn: (turn) => {
              const live = loadSimRun(run.id)
              if (live) appendSimTurn(live, turn)
            },
          })
          const live = loadSimRun(run.id)
          if (live) finishSimRun(live, { done: result.done, summary: result.summary, error: result.error })
          await recordSession({
            provider: "sim",
            model: "sim-agent",
            prompt: `[sim run] ${task} (via /serve)`,
            response: `${result.done ? "done" : "failed"}: ${result.summary || result.error || ""}`.slice(0, 4000),
            exitCode: result.done ? 0 : 1,
            durationMs: Date.now() - startMs,
            rlmDepth: 0,
          })
        } catch (err) {
          const live = loadSimRun(run.id)
          if (live) finishSimRun(live, {
            done: false,
            summary: "",
            error: err instanceof Error ? err.message : String(err),
          })
        }
      })()
      sendJson(res, 202, { started: true, id: run.id, task })
    },

    "/api/sim/cameras/:name/path": async ({ res, params, body }) => {
      try {
        const payload = (typeof body === "object" && body !== null ? body : {}) as {
          keyframes?: unknown
        }
        const keyframes = Array.isArray(payload.keyframes) ? payload.keyframes : []
        if (keyframes.length === 0) {
          sendError(res, 400, `body must be {"keyframes": [{"t","pos","lookat"}, ...]}`)
          return
        }
        const b = await getSimBridge()
        sendJson(res, 200, await b.cameraPathSet(params.name, keyframes as never))
      } catch (err) {
        sendError(res, 503, `sim world unavailable: ${err instanceof Error ? err.message : err}`)
      }
    },

    "/api/sim/cameras/:name/path/clear": async ({ res, params }) => {
      try {
        const b = await getSimBridge()
        sendJson(res, 200, await b.cameraPathClear(params.name))
      } catch (err) {
        sendError(res, 503, `sim world unavailable: ${err instanceof Error ? err.message : err}`)
      }
    },

    "/api/sim/estop": async ({ res }) => {
      try {
        const b = await getSimBridge()
        const result = await b.request("estop")
        sendJson(res, 200, result)
      } catch (err) {
        sendError(res, 503, `sim world unavailable: ${err instanceof Error ? err.message : err}`)
      }
    },

    "/api/sim/resume": async ({ res }) => {
      try {
        const b = await getSimBridge()
        const result = await b.request("resume")
        sendJson(res, 200, result)
      } catch (err) {
        sendError(res, 503, `sim world unavailable: ${err instanceof Error ? err.message : err}`)
      }
    },

    // -- Sim workbench actions ------------------------------------------------

    "/api/sim/preview": async ({ res, body }) => {
      try {
        const payload = (typeof body === "object" && body !== null ? body : {}) as { code?: unknown }
        const code = typeof payload.code === "string" ? payload.code : ""
        if (!code.trim()) {
          sendError(res, 400, `body must be {"code": "<scene setup python>"}`)
          return
        }
        const b = await getSimBridge()
        const result = await b.scenePreview(code)
        sendJson(res, result.ok ? 200 : 422, result)
      } catch (err) {
        sendError(res, 503, `sim world unavailable: ${err instanceof Error ? err.message : err}`)
      }
    },

    "/api/sim/rebuild": async ({ res }) => {
      try {
        const b = await getSimBridge()
        sendJson(res, 200, await b.sceneRebuild())
      } catch (err) {
        sendError(res, 503, `sim world unavailable: ${err instanceof Error ? err.message : err}`)
      }
    },

    "/api/sim/time": async ({ res, body }) => {
      try {
        const payload = (typeof body === "object" && body !== null ? body : {}) as {
          action?: unknown
          n?: unknown
          speed?: unknown
        }
        const action = payload.action
        if (action !== "play" && action !== "pause" && action !== "step" && action !== "speed") {
          sendError(res, 400, `action must be play|pause|step|speed`)
          return
        }
        const b = await getSimBridge()
        const result = await b.timeControl(action, {
          ...(typeof payload.n === "number" ? { n: payload.n } : {}),
          ...(typeof payload.speed === "number" ? { speed: payload.speed } : {}),
        })
        sendJson(res, 200, result)
      } catch (err) {
        sendError(res, 503, `sim world unavailable: ${err instanceof Error ? err.message : err}`)
      }
    },

    "/api/sim/cameras": async ({ res, body }) => {
      try {
        const payload = (typeof body === "object" && body !== null ? body : {}) as {
          name?: unknown
        }
        if (typeof payload.name !== "string" || !payload.name.trim()) {
          sendError(res, 400, `camera spec needs a "name"`)
          return
        }
        const b = await getSimBridge()
        const result = await b.cameraAdd(payload as { name: string })
        sendJson(res, 200, result)
      } catch (err) {
        sendError(res, 503, `sim world unavailable: ${err instanceof Error ? err.message : err}`)
      }
    },

    "/api/sim/cameras/:name/remove": async ({ res, params }) => {
      try {
        const b = await getSimBridge()
        sendJson(res, 200, await b.cameraRemove(params.name))
      } catch (err) {
        sendError(res, 503, `sim world unavailable: ${err instanceof Error ? err.message : err}`)
      }
    },

    "/api/sim/cameras/:name/snapshot": async ({ res, params }) => {
      try {
        const b = await getSimBridge()
        const shot = await b.cameraSnapshot(params.name)
        // Convert the world-side absolute path to a servable frame URL
        const file = shot.rgb?.split(/[\\/]/).pop()
        sendJson(res, 200, { ...shot, url: file ? `/api/sim/frames/${file}` : undefined })
      } catch (err) {
        sendError(res, 503, `sim world unavailable: ${err instanceof Error ? err.message : err}`)
      }
    },

    "/api/chat": async ({ req, res, body }) => {
      const payload = (typeof body === "object" && body !== null ? body : {}) as {
        prompt?: unknown
        stream?: unknown
      }
      const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : ""
      if (!prompt) {
        sendError(res, 400, `body must be {"prompt": "..."}`)
        return
      }
      const wantStream = payload.stream === true
      const provider = await resolveProviderConfig()
      if (!provider) {
        const mock = mockChatReply(prompt)
        if (!wantStream) {
          sendJson(res, 200, { reply: mock, mock: true, model: "mock", provider: "mock" })
          return
        }
        const push = openSse(res)
        push("meta", { mock: true, provider: "mock", model: "mock" })
        // Emit the mock reply in small chunks so the UI streams like a real model.
        let emitted = 0
        const timer = setInterval(() => {
          const next = mock.slice(emitted, emitted + 24)
          if (!next) {
            clearInterval(timer)
            push("done", { reply: mock })
            res.end()
            return
          }
          emitted += next.length
          push("delta", { text: next })
        }, 18)
        req.on("close", () => clearInterval(timer))
        return
      }

      if (!wantStream) {
        const reply = await chatComplete({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.model,
          messages: [{ role: "user", content: prompt }],
          stream: false,
          temperature: 0.7,
          timeout: 180_000,
        })
        sendJson(res, 200, { reply, model: provider.model, provider: provider.providerName })
        return
      }

      const push = openSse(res)
      push("meta", { mock: false, provider: provider.providerName, model: provider.model })
      try {
        const reply = await chatComplete({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model: provider.model,
          messages: [{ role: "user", content: prompt }],
          stream: true,
          temperature: 0.7,
          timeout: 180_000,
          onToken: (text) => push("delta", { text }),
        })
        push("done", { reply })
        res.end()
      } catch (err) {
        push("error", { message: err instanceof Error ? err.message : String(err) })
        res.end()
      }
    },
  }
}
