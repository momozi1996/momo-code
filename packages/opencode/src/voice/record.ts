/**
 * Voice recording — capture mic audio via the bundled Python recorder.
 *
 * Uses sounddevice (already present in most scientific Python envs)
 * because Node/Bun has no cross-platform mic API without native deps.
 *
 * Resolution order for the Python executable:
 *   MOMO_VOICE_PYTHON → MOMO_SIM_PYTHON → "python"
 *
 * @module voice/record
 */

import { spawn } from "child_process"
import * as path from "path"
import { fileURLToPath } from "url"

export interface RecordResult {
  readonly path: string
  readonly seconds: number
  readonly peak: number
}

/** Default path of the bundled recorder script. */
export function defaultRecorderPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(here, "..", "..", "python", "voice", "record.py")
}

function resolvePython(): string {
  return (
    process.env.MOMO_VOICE_PYTHON ||
    process.env.MOMO_SIM_PYTHON ||
    "python"
  )
}

/**
 * Record `seconds` of microphone audio to `outPath` (WAV, 16kHz mono).
 * Throws with an actionable message on failure.
 */
export function recordAudio(
  outPath: string,
  seconds: number,
): Promise<RecordResult> {
  const python = resolvePython()
  const script = process.env.MOMO_VOICE_RECORDER || defaultRecorderPath()

  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-u", script, outPath, String(seconds)], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })

    let stdout = ""
    let stderr = ""
    const timer = setTimeout(
      () => {
        child.kill()
        reject(new Error(`recording timed out after ${seconds + 15}s`))
      },
      (seconds + 15) * 1000,
    )

    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()))
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()))
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(
        new Error(
          `failed to start python recorder: ${err.message} (set MOMO_VOICE_PYTHON)`,
        ),
      )
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(
          new Error(
            `recorder exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
          ),
        )
        return
      }
      try {
        const info = JSON.parse(stdout.trim().split("\n").pop() || "{}")
        resolve({
          path: info.path || outPath,
          seconds: info.seconds ?? seconds,
          peak: info.peak ?? 0,
        })
      } catch {
        reject(new Error(`recorder returned unparseable output: ${stdout.slice(0, 200)}`))
      }
    })
  })
}
