/**
 * /serve command — local HTTP server + dashboard.
 *
 *   momo serve [--port=4097] [--host=127.0.0.1] [--token=xxx]
 *
 * Exposes momo's state (sessions, /optim studies, /sim world, goals,
 * schedule) as a JSON API + SSE live feed, and serves a single-file
 * dashboard at /. Binds loopback only unless a token is set.
 */
import { createServeApp } from "../../serve/server.js"

const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

export async function runServeCommand(args: string[]): Promise<void> {
  let port: number | undefined
  let host: string | undefined
  let token: string | undefined
  for (const a of args) {
    if (a.startsWith("--port=")) port = Number(a.slice(7)) || undefined
    else if (a.startsWith("--host=")) host = a.slice(7)
    else if (a.startsWith("--token=")) token = a.slice(8)
  }

  try {
    const app = await createServeApp({
      ...(port ? { port } : {}),
      ...(host ? { host } : {}),
      ...(token ? { token } : {}),
    })
    console.log(`${GREEN}✓${RESET} momo serve listening at ${CYAN}${app.url}${RESET}`)
    console.log(`  dashboard: ${app.url}/`)
    if (token) console.log(`  auth: Bearer token enabled`)
    console.log(`${DIM}Ctrl+C to stop${RESET}`)

    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve())
      process.once("SIGTERM", () => resolve())
    })
    await app.close()
    console.log(`\n${DIM}stopped${RESET}`)
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
}
