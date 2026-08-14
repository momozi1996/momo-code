/**
 * Speech-to-text — transcribe audio via an OpenAI-compatible
 * `/audio/transcriptions` endpoint (OpenAI Whisper, Groq, and many
 * compatible gateways).
 *
 * Configuration (env):
 *   MOMO_STT_API_KEY   → MOMO_OPENAI_API_KEY → MOMO_API_KEY
 *   MOMO_STT_BASE_URL  (default: https://api.openai.com/v1;
 *                        Groq: https://api.groq.com/openai/v1)
 *   MOMO_STT_MODEL     (default: whisper-1; Groq: whisper-large-v3)
 *
 * @module voice/stt
 */

import * as fs from "fs"
import * as path from "path"

export interface SttConfig {
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
}

/** Resolve STT config from env. Returns null when no key is available. */
export function resolveSttConfig(): SttConfig | null {
  const apiKey =
    process.env.MOMO_STT_API_KEY ||
    process.env.MOMO_OPENAI_API_KEY ||
    process.env.MOMO_API_KEY
  if (!apiKey) return null
  return {
    baseUrl: process.env.MOMO_STT_BASE_URL || "https://api.openai.com/v1",
    apiKey,
    model: process.env.MOMO_STT_MODEL || "whisper-1",
  }
}

export interface TranscribeOpts {
  readonly config?: SttConfig
  readonly language?: string
  readonly timeoutMs?: number
  /** Injected for tests — defaults to global fetch */
  readonly fetchImpl?: typeof fetch
}

/**
 * Transcribe an audio file (wav/mp3/m4a/...) to text.
 * Throws with an actionable message on failure.
 */
export async function transcribeAudio(
  audioPath: string,
  opts: TranscribeOpts = {},
): Promise<string> {
  const config = opts.config ?? resolveSttConfig()
  if (!config) {
    throw new Error(
      "no STT API key — set MOMO_STT_API_KEY (or MOMO_OPENAI_API_KEY / MOMO_API_KEY)",
    )
  }
  if (!fs.existsSync(audioPath)) {
    throw new Error(`audio file not found: ${audioPath}`)
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const data = fs.readFileSync(audioPath)
  const filename = path.basename(audioPath)

  const form = new FormData()
  form.append("file", new Blob([data]), filename)
  form.append("model", config.model)
  if (opts.language) form.append("language", opts.language)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000)

  try {
    const response = await fetchImpl(`${config.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      throw new Error(
        `STT HTTP ${response.status}: ${errorText.slice(0, 300) || response.statusText}`,
      )
    }

    const json = (await response.json()) as { text?: string }
    if (typeof json.text !== "string") {
      throw new Error("STT response missing 'text' field")
    }
    return json.text.trim()
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("STT request timed out")
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
