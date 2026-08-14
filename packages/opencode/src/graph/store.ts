/**
 * Graph Engine — persistence layer.
 *
 * Runs live in `~/.momo/graphs/<id>.json` (atomic writes). A run is
 * saved after every node batch, so `momo /graph resume <id>` continues
 * exactly where a long-horizon run stopped.
 *
 * @module graph/store
 */

import * as fs from "fs"
import * as path from "path"
import * as crypto from "crypto"
import { getMomoHome } from "../session/recorder.js"
import type { GraphRun } from "./types.js"

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getGraphsDir(): string {
  return path.join(getMomoHome(), "graphs")
}

export function graphFile(id: string): string {
  return path.join(getGraphsDir(), `${id}.json`)
}

export function newRunId(): string {
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 8)
  return `graph_${ts}_${rand}`
}

// ---------------------------------------------------------------------------
// CRUD (atomic writes)
// ---------------------------------------------------------------------------

export function saveRun(run: GraphRun): void {
  const file = graphFile(run.id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2), "utf-8")
  fs.renameSync(tmp, file)
}

export function loadRun(id: string): GraphRun | null {
  try {
    const file = graphFile(id)
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, "utf-8")) as GraphRun
  } catch {
    return null
  }
}

/** All runs, newest first. Skips corrupt files. */
export function listRuns(): GraphRun[] {
  try {
    const dir = getGraphsDir()
    if (!fs.existsSync(dir)) return []
    const out: GraphRun[] = []
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as GraphRun)
      } catch {
        // skip corrupt run
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  } catch {
    return []
  }
}
