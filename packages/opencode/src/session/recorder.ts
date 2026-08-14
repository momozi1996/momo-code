/**
 * Session trajectory recorder — the shared foundation for /refine and
 * signal mining.
 *
 * Every completed chat run appends one JSONL record to
 * `~/.momo/sessions/YYYY-MM-DD.jsonl`. Responses are truncated and
 * scrubbed of secrets before persistence.
 *
 * Disable with `MOMO_SESSION_RECORD=false`.
 *
 * @module session/recorder
 */

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import * as crypto from "crypto"
import { Effect } from "effect"
import { Guard } from "../evolve/guard.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionRecord {
  /** Unique record id: `ses_<hash>` */
  readonly id: string
  /** ISO-8601 timestamp */
  readonly ts: string
  readonly provider: string
  readonly model: string
  /** The user prompt (scrubbed, truncated) */
  readonly prompt: string
  /** The assistant response (scrubbed, truncated to 8KB) */
  readonly response: string
  /** Process exit code of the chat run (0 = success) */
  readonly exitCode: number
  readonly durationMs: number
  /** RLM depth when running as a subagent (0 = top-level) */
  readonly rlmDepth: number
}

// ---------------------------------------------------------------------------
// Paths & config
// ---------------------------------------------------------------------------

/** Max chars of the response persisted per record. */
const MAX_RESPONSE_CHARS = 8192

/** Max chars of the prompt persisted per record. */
const MAX_PROMPT_CHARS = 4096

/** Get the momo home directory (`MOMO_CONFIG_DIR` or `~/.momo`). */
export function getMomoHome(): string {
  return process.env.MOMO_CONFIG_DIR || path.join(os.homedir(), ".momo")
}

/** Get the sessions directory path. */
export function getSessionsDir(): string {
  return path.join(getMomoHome(), "sessions")
}

function isRecordingEnabled(): boolean {
  const v = process.env.MOMO_SESSION_RECORD
  return v !== "false" && v !== "0"
}

// ---------------------------------------------------------------------------
// Scrubbing
// ---------------------------------------------------------------------------

/**
 * Scrub secrets/PII from free text using the evolve Guard patterns.
 * Best-effort: returns the original text if scrubbing fails.
 */
export async function scrubText(text: string): Promise<string> {
  try {
    const scrubbed = await Effect.runPromise(
      Guard.scrubSecrets([{ context: text }]),
    )
    return scrubbed[0]?.context ?? text
  } catch {
    return text
  }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/**
 * Persist one session record. Never throws — recording is best-effort
 * and must not break the chat loop.
 */
export async function recordSession(
  input: Omit<SessionRecord, "id" | "ts" | "prompt" | "response"> & {
    prompt: string
    response: string
  },
): Promise<SessionRecord | null> {
  if (!isRecordingEnabled()) return null

  try {
    const prompt = (await scrubText(input.prompt)).slice(0, MAX_PROMPT_CHARS)
    const response = (await scrubText(input.response)).slice(
      0,
      MAX_RESPONSE_CHARS,
    )

    const record: SessionRecord = {
      id: `ses_${crypto.createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 12)}`,
      ts: new Date().toISOString(),
      provider: input.provider,
      model: input.model,
      prompt,
      response,
      exitCode: input.exitCode,
      durationMs: input.durationMs,
      rlmDepth: input.rlmDepth,
    }

    const dir = getSessionsDir()
    fs.mkdirSync(dir, { recursive: true })
    const day = record.ts.slice(0, 10)
    fs.appendFileSync(
      path.join(dir, `${day}.jsonl`),
      JSON.stringify(record) + "\n",
      "utf-8",
    )
    return record
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Reading (for /refine)
// ---------------------------------------------------------------------------

/**
 * Read the most recent session records, newest last.
 * Scans `YYYY-MM-DD.jsonl` files in reverse chronological order.
 */
export function readRecentSessions(limit: number): SessionRecord[] {
  try {
    const dir = getSessionsDir()
    if (!fs.existsSync(dir)) return []

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse()

    const records: SessionRecord[] = []
    for (const file of files) {
      const lines = fs
        .readFileSync(path.join(dir, file), "utf-8")
        .split("\n")
        .filter((l) => l.trim())
      for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) {
        try {
          records.push(JSON.parse(lines[i]) as SessionRecord)
        } catch {
          // skip malformed lines
        }
      }
      if (records.length >= limit) break
    }
    return records.reverse().slice(-limit)
  } catch {
    return []
  }
}
