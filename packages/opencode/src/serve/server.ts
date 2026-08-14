/**
 * momo serve — local HTTP server + dashboard.
 *
 * Zero new dependencies (Node's built-in `http`). Architecture mirrors the
 * CLI: stateless reads from the ~/.momo stores + one-shot writes — no
 * second session model. SSE is plain `text/event-stream`; the optim live
 * feed polls trials.jsonl every 2s and pushes increments (fs.watch is
 * unreliable on Windows).
 *
 * Safety rails:
 *   - binds 127.0.0.1 by default; binding a non-loopback host requires a
 *     token (refused with a loud error otherwise)
 *   - every handler is wrapped — one bad request can never crash the server
 *
 * @module serve/server
 */

import * as http from "http"
import * as fs from "fs"
import * as path from "path"
import { createRequire } from "module"
import { fileURLToPath } from "url"
import { getMomoHome } from "../session/recorder.js"
import { resolveProviderConfig } from "../cli/chat.js"
import { getRoutes } from "./routes.js"
import { getActions } from "./actions.js"

const require = createRequire(import.meta.url)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServeOptions {
  readonly host?: string
  readonly port?: number
  /** Bearer token; empty = no auth (loopback only) */
  readonly token?: string
}

export interface ServeApp {
  readonly url: string
  readonly host: string
  readonly port: number
  close(): Promise<void>
}

export type RouteHandler = (ctx: RequestContext) => Promise<void> | void

export interface RequestContext {
  readonly req: http.IncomingMessage
  readonly res: http.ServerResponse
  /** Named path params (":name" segments) */
  readonly params: Record<string, string>
  /** Parsed query string */
  readonly query: URLSearchParams
  /** Parsed JSON body (POST); undefined when absent/invalid */
  readonly body: unknown
}

interface Route {
  readonly method: "GET" | "POST"
  readonly pattern: string
  readonly regex: RegExp
  readonly names: string[]
  readonly handler: RouteHandler
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data, null, 2)
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  res.end(body)
}

export function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message })
}

function sendHtml(res: http.ServerResponse, html: string): void {
  // No caching: dashboard HTML is a single file read from src/serve on every
  // request, so browser refreshes always pick up the latest version.
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  })
  res.end(html)
}

/** Open an SSE channel; returns a push function. Caller must clear timers. */
export function openSse(res: http.ServerResponse): (event: string, data: unknown) => void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  })
  res.write(`retry: 3000\n\n`)
  return (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"))
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function compileRoute(method: "GET" | "POST", pattern: string, handler: RouteHandler): Route {
  const names: string[] = []
  const regex = new RegExp(
    "^" +
      pattern
        .split("/")
        .map((seg) => {
          if (seg.startsWith(":")) {
            names.push(seg.slice(1))
            return "([^/]+)"
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        })
        .join("/") +
      "$",
  )
  return { method, pattern, regex, names, handler }
}

function buildRoutes(): Route[] {
  const routes: Route[] = []
  for (const [pattern, handler] of Object.entries(getRoutes())) {
    routes.push(compileRoute("GET", pattern, handler))
  }
  for (const [pattern, handler] of Object.entries(getActions())) {
    routes.push(compileRoute("POST", pattern, handler))
  }
  return routes
}

// ---------------------------------------------------------------------------
// Version (for /api/health)
// ---------------------------------------------------------------------------

function getVersion(): string {
  try {
    const { version } = require("../../package.json")
    return version || "0.0.0"
  } catch {
    return "0.0.0"
  }
}

// ---------------------------------------------------------------------------
// Dashboard (single-file, no build step)
// ---------------------------------------------------------------------------

function serveHtmlFile(filename: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  // tsc does not copy assets: from dist/serve/ fall back to src/serve/
  for (const candidate of [
    path.join(here, filename),
    path.resolve(here, "..", "..", "src", "serve", filename),
  ]) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, "utf-8")
  }
  throw new Error(`${filename} not found`)
}

/** Serve a binary file from a whitelisted directory (path-traversal safe). */
export function sendFile(
  res: http.ServerResponse,
  dir: string,
  filename: string,
  contentType: string,
): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(filename)) {
    sendError(res, 403, "invalid filename")
    return
  }
  const file = path.join(dir, filename)
  if (!file.startsWith(path.resolve(dir)) || !fs.existsSync(file)) {
    sendError(res, 404, `file not found: ${filename}`)
    return
  }
  res.writeHead(200, { "Content-Type": contentType })
  fs.createReadStream(file).pipe(res)
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export async function createServeApp(opts: ServeOptions = {}): Promise<ServeApp> {
  const host = opts.host ?? process.env.MOMO_SERVE_HOST ?? "127.0.0.1"
  const port = opts.port ?? (Number(process.env.MOMO_SERVE_PORT) || 4097)
  const token = opts.token ?? process.env.MOMO_SERVE_TOKEN

  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1"
  if (!isLoopback && !token) {
    throw new Error(
      `Refusing to bind ${host} without a token. ` +
        `Set --token (or MOMO_SERVE_TOKEN) for non-loopback serving.`,
    )
  }

  const routes = buildRoutes()
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)

      // Auth: Bearer token, or ?token= for browser EventSource (SSE)
      if (token) {
        const auth = req.headers.authorization ?? ""
        if (auth !== `Bearer ${token}` && url.searchParams.get("token") !== token) {
          sendError(res, 401, "missing or invalid bearer token")
          return
        }
      }

      // Dashboard / workbench pages
      if (req.method === "GET" && url.pathname === "/") {
        sendHtml(res, serveHtmlFile("dashboard.html"))
        return
      }
      if (req.method === "GET" && url.pathname === "/workbench") {
        sendHtml(res, serveHtmlFile("workbench.html"))
        return
      }

      // Health
      if (req.method === "GET" && url.pathname === "/api/health") {
        const provider = await resolveProviderConfig()
        sendJson(res, 200, {
          ok: true,
          version: getVersion(),
          momoHome: getMomoHome(),
          providerConfigured: !!provider,
        })
        return
      }

      // Route match
      for (const route of routes) {
        if (route.method !== req.method) continue
        const m = route.regex.exec(url.pathname)
        if (!m) continue
        const params: Record<string, string> = {}
        route.names.forEach((name, i) => {
          params[name] = decodeURIComponent(m[i + 1])
        })
        const body = req.method === "POST" ? await readBody(req) : undefined
        await route.handler({ req, res, params, query: url.searchParams, body })
        return
      }

      sendError(res, 404, `no route: ${req.method} ${url.pathname}`)
    } catch (err) {
      // One bad request must never crash the server
      try {
        sendError(res, 500, err instanceof Error ? err.message : String(err))
      } catch {
        // response already ended — swallow
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => resolve())
  })

  const address = server.address()
  const actualPort = typeof address === "object" && address ? address.port : port
  const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${actualPort}`

  return {
    url,
    host,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}
