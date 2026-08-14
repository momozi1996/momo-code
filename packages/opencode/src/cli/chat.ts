import { loadActiveCcSwitchProvider } from "../provider/cc-switch.js"
import { recordSession } from "../session/recorder.js"
import { SignalScorer } from "../evolve/signals.js"
import { getPromptPatchPath } from "../refine/apply.js"
import { activeGoalsBlock } from "../goal/store.js"
import * as fs from "fs"

/**
 * MOMO CODE — Core agent chat loop.
 *
 * The minimal viable agent loop:
 *   prompt → resolve provider + model → fetch /chat/completions
 *   → parse SSE stream → print tokens
 *
 * Uses native fetch + SSE parsing. Works with any OpenAI-compatible endpoint.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import { Effect } from "effect"
import {
  InjectForTask,
  SelectorLive,
  InjectorLive,
  ExperienceStoreLive,
} from "../experience/index.js"

interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

interface ChatOptions {
  /** Provider base URL (e.g. https://api.minimaxi.com/v1) */
  baseUrl: string
  /** API key */
  apiKey: string
  /** Model ID */
  model: string
  /** System prompt */
  system?: string
  /** User messages */
  messages: ChatMessage[]
  /** Stream or non-streaming */
  stream?: boolean
  /** Temperature */
  temperature?: number
  /** Extra headers */
  headers?: Record<string, string>
  /** Request timeout in ms */
  timeout?: number
  /** Optional per-token callback when streaming (serve SSE, UI progress). */
  onToken?: (chunk: string) => void
  /** Optional usage callback (token counters from the provider response). */
  onUsage?: (usage: Usage) => void
}

/** Token usage counters reported by an OpenAI-compatible endpoint. */
export interface Usage {
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly totalTokens?: number
}

function numOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const CYAN = "\x1b[36m"
const GREEN = "\x1b[32m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"
const MAGENTA = "\x1b[95m"

// ---------------------------------------------------------------------------
// SSE stream parser
// ---------------------------------------------------------------------------

/**
 * Parse a Server-Sent Events stream into text chunks.
 * Handles the standard OpenAI stream format:
 *   data: {"choices":[{"delta":{"content":"Hello"}}]}
 *   data: [DONE]
 */
/** One streamed token from the model. */
interface SSEChunk {
  readonly text: string
  /** True when the chunk is model reasoning, not part of the final answer. */
  readonly reasoning: boolean
}

async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onUsage?: (usage: Usage) => void,
): AsyncGenerator<SSEChunk, void> {
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    // Process complete lines
    let lineEnd: number
    while ((lineEnd = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, lineEnd).trim()
      buffer = buffer.slice(lineEnd + 1)

      if (!line.startsWith("data: ")) continue
      const data = line.slice(6)

      if (data === "[DONE]") return

      try {
        const parsed = JSON.parse(data)
        // OpenAI format: choices[0].delta.content
        const content = parsed.choices?.[0]?.delta?.content
        if (content) yield { text: content, reasoning: false }
        // Also handle 'reasoning_content' (some Chinese providers)
        const reasoning = parsed.choices?.[0]?.delta?.reasoning_content
        if (reasoning) yield { text: reasoning, reasoning: true }
        // Usage arrives in the final chunk when stream_options.include_usage
        const usage = parsed.usage
        if (usage && typeof usage === "object") {
          onUsage?.({
            promptTokens: numOrUndefined(usage.prompt_tokens),
            completionTokens: numOrUndefined(usage.completion_tokens),
            totalTokens: numOrUndefined(usage.total_tokens),
          })
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Chat completion caller
// ---------------------------------------------------------------------------

/**
 * Call an OpenAI-compatible chat completions endpoint.
 * Returns the full response text (non-streaming) or prints tokens (streaming).
 */
export async function chatComplete(opts: ChatOptions): Promise<string> {
  const {
    baseUrl,
    apiKey,
    model,
    system,
    messages,
    stream = true,
    temperature = 0.7,
    headers: extraHeaders = {},
    timeout = 120_000,
    onToken,
    onUsage,
  } = opts

  // Build messages array
  const bodyMessages: ChatMessage[] = system
    ? [{ role: "system", content: system }, ...messages]
    : [...messages]

  const bodyPayload: Record<string, unknown> = {
    model,
    messages: bodyMessages,
    stream,
    temperature,
  }
  // Request usage counters on streaming calls only when someone consumes
  // them (graph nodes/planner/synthesis). Graceful: a provider that
  // rejects `stream_options` gets a plain retry below.
  const wantUsage = stream && typeof onUsage === "function"
  if (wantUsage) bodyPayload.stream_options = { include_usage: true }
  const body = JSON.stringify(bodyPayload)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    let response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body,
      signal: controller.signal,
    })

    // Some providers reject `stream_options` with a 400 — retry once plain.
    if (response.status === 400 && wantUsage) {
      const plainBody = JSON.stringify({
        model,
        messages: bodyMessages,
        stream,
        temperature,
      })
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...extraHeaders,
        },
        body: plainBody,
        signal: controller.signal,
      })
    }

    clearTimeout(timer)

    if (!response.ok) {
      const errorText = await response.text().catch(() => "")
      throw new Error(
        `HTTP ${response.status}: ${response.statusText}${errorText ? ` | ${errorText.slice(0, 500)}` : ""}`,
      )
    }

    if (!stream) {
      // Non-streaming: parse full JSON response
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown }
      }
      const usage = data.usage
      if (usage && typeof usage === "object") {
        onUsage?.({
          promptTokens: numOrUndefined(usage.prompt_tokens),
          completionTokens: numOrUndefined(usage.completion_tokens),
          totalTokens: numOrUndefined(usage.total_tokens),
        })
      }
      return data.choices?.[0]?.message?.content || ""
    }

    // Streaming: parse SSE and collect tokens
    if (!response.body) {
      throw new Error("No response body for streaming")
    }

    const reader = response.body.getReader()
    let fullText = ""

    for await (const { text, reasoning } of parseSSEStream(reader, onUsage)) {
      // Reasoning is meta-output: keep it off stdout so captured subagent
      // stdout is just the final answer. Interactive terminals still show it.
      if (reasoning) process.stderr.write(text)
      else process.stdout.write(text)
      fullText += text
      onToken?.(text)
    }

    return fullText
  } catch (err) {
    clearTimeout(timer)
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request timed out after ${timeout}ms`)
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Provider configuration resolver
// ---------------------------------------------------------------------------

/**
 * Resolve provider config from environment variables.
 * Returns null if no credentials found.
 */
export async function resolveProviderConfig(): Promise<{
  baseUrl: string
  apiKey: string
  model: string
  providerName: string
} | null> {
  // 1. Try CC Switch active provider first (white-collar zero-config path).
  //    momo is opencode-based: prefer opencode, fall back to claude.
  const ccProvider =
    (await loadActiveCcSwitchProvider("opencode")) ||
    (await loadActiveCcSwitchProvider("claude"))
  if (ccProvider) {
    const factory = getFactoryConfig(ccProvider.providerName)
    return {
      baseUrl: ccProvider.baseUrl || factory.baseUrl || "",
      apiKey: ccProvider.apiKey,
      model: ccProvider.model || factory.defaultModel || "gpt-4",
      providerName: ccProvider.providerName,
    }
  }

  // 2. Fall back to environment variables.
  const genericKey = process.env.MOMO_API_KEY
  const provider = process.env.MOMO_PROVIDER || "openai"

  // Check provider-specific key
  const providerUpper = provider.toUpperCase().replace(/-/g, "_")
  const specificKey =
    process.env[`MOMO_${providerUpper}_API_KEY`] ||
    process.env[`MOMO_${provider.replace(/-/g, "_").toUpperCase()}_API_KEY`]

  const apiKey = specificKey || genericKey
  if (!apiKey) return null

  // Get base URL from factory or env
  const baseUrlFromEnv = process.env.MOMO_BASE_URL
  const modelFromEnv = process.env.MOMO_MODEL

  // Use factory to get defaults
  const factory = getFactoryConfig(provider)

// Resolve model, handling tier names (ultra/standard/lite)
  let resolvedModel = modelFromEnv || factory.defaultModel || "gpt-4"
  const tierModels: Record<string, string> = {
    ultra: "claude-sonnet-4-20250514",
    standard: "gpt-4.1",
    lite: "gpt-4.1-mini",
  }
  if (resolvedModel && tierModels[resolvedModel.toLowerCase()]) {
    resolvedModel = tierModels[resolvedModel.toLowerCase()]
  }

  return {
    baseUrl: baseUrlFromEnv || factory.baseUrl || "",
    apiKey,
    model: resolvedModel,
    providerName: provider,
  }
}

/** @deprecated Use resolveProviderConfig() instead. */
export function resolveProviderFromEnv(): ReturnType<typeof resolveProviderConfig> {
  return resolveProviderConfig()
}

/** Get factory defaults for a provider name. */
function getFactoryConfig(name: string): {
  baseUrl?: string
  defaultModel?: string
} {
  // Inline minimal factories (avoid importing provider.ts at runtime)
  const factories: Record<string, { baseUrl: string; defaultModel: string }> = {
    openai: { baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4.1" },
    anthropic: {
      baseUrl: "https://api.anthropic.com/v1",
      defaultModel: "claude-sonnet-4-20250514",
    },
    google: {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      defaultModel: "gemini-2.5-flash-preview-04-17",
    },
    openrouter: {
      baseUrl: "https://openrouter.ai/api/v1",
      defaultModel: "anthropic/claude-sonnet-4",
    },
    groq: {
      baseUrl: "https://api.groq.com/openai/v1",
      defaultModel: "llama-3.1-70b-versatile",
    },
    minimax: {
      baseUrl: "https://api.minimaxi.com/v1",
      defaultModel: "MiniMax-M2.7",
    },
    zhipu: {
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      defaultModel: "glm-4-plus",
    },
    moonshot: {
      baseUrl: "https://api.moonshot.cn/v1",
      defaultModel: "moonshot-v1-128k",
    },
    doubao: {
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      defaultModel: "doubao-pro-128k",
    },
    stepfun: {
      baseUrl: "https://api.stepfun.com/v1",
      defaultModel: "step-2-16k",
    },
    alibaba: {
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      defaultModel: "qwen2.5-72b-instruct",
    },
    mistral: {
      baseUrl: "https://api.mistral.ai/v1",
      defaultModel: "mistral-large-latest",
    },
    xai: { baseUrl: "https://api.x.ai/v1", defaultModel: "grok-2" },
    custom: {
      baseUrl: process.env.MOMO_CUSTOM_BASE_URL || "",
      defaultModel: process.env.MOMO_CUSTOM_MODEL || "",
    },
  }

  return factories[name] || { baseUrl: "", defaultModel: "gpt-4" }
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const DEFAULT_SYSTEM_PROMPT = `You are MOMO CODE, an AI coding assistant. You help users write, refactor, debug, and understand code.

Guidelines:
- Provide concise, actionable responses
- Use code blocks with language tags for code
- Ask clarifying questions when requirements are ambiguous
- Prefer modern best practices
- Consider security implications`

// ---------------------------------------------------------------------------
// Main chat loop
// ---------------------------------------------------------------------------

/**
 * Run a single-turn chat session.
 *
 * @param prompt — The user's coding request
 * @returns Exit code (0 = success, 1 = error)
 */
export async function runChat(prompt: string): Promise<number> {
  // Resolve provider configuration
  const config = await resolveProviderConfig()

  if (!config) {
    console.error(`${RESET}`)
    console.error(
      `${MAGENTA}MOMO CODE${RESET}: No API key configured.\n`,
    )
    console.error(`Set one of the following environment variables:`)
    console.error(`  ${CYAN}MOMO_API_KEY${RESET}          Generic key (works with any provider)`)
    console.error(`  ${CYAN}MOMO_<PROVIDER>_API_KEY${RESET}  Provider-specific key`)
    console.error(`\nExamples:`)
    console.error(`  export MOMO_API_KEY=sk-...`)
    console.error(`  export MOMO_MINIMAX_API_KEY=sk-...`)
    console.error(`  export MOMO_PROVIDER=minimax`)
    console.error(`\nSupported providers: openai, anthropic, google, openrouter,`)
    console.error(`  minimax, zhipu, moonshot, doubao, stepfun, alibaba, ...`)
    console.error(`\nDocs: https://momozi.cc`)
    return 1
  }

  if (!config.baseUrl) {
    console.error(
      `${MAGENTA}MOMO CODE${RESET}: Provider "${config.providerName}" has no base URL.`,
    )
    console.error(`Set ${CYAN}MOMO_BASE_URL${RESET} or check the provider name.`)
    return 1
  }

  // Print session header
  console.error(
    `${DIM}→ ${config.providerName} | ${config.model}${RESET}`,
  )
  console.error(``)

  try {
    // Resolve system prompt with tactic injection
    let systemPrompt = DEFAULT_SYSTEM_PROMPT
    try {
      const result = await Effect.runPromise(
        InjectForTask({
          id: `chat_${Date.now()}`,
          description: prompt,
          // Synthetic session-start signal so trigger patterns can match
          // (same convention as `momo /evolve --inject`).
          signals: [SignalScorer.fromExitCode(0, "bash")],
        }).pipe(
          Effect.provide(SelectorLive),
          Effect.provide(InjectorLive),
          Effect.provide(ExperienceStoreLive),
        ),
      )
      if (result.block && result.block.length > 0) {
        systemPrompt = DEFAULT_SYSTEM_PROMPT + "\n\n---\n\n" + result.block
      }
    } catch {
      // Tactic injection failed, use default prompt
    }

    // Inject human-approved /refine prompt patches (persistent self-improvement)
    try {
      const patchPath = getPromptPatchPath()
      if (fs.existsSync(patchPath)) {
        const patch = fs.readFileSync(patchPath, "utf-8").trim()
        if (patch) {
          systemPrompt += "\n\n---\n\n## Refined Behavior (approved patches)\n" + patch
        }
      }
    } catch {
      // Prompt patch injection is best-effort
    }

    // Inject active persistent goals (long-term objectives across sessions)
    try {
      const goalsBlock = activeGoalsBlock()
      if (goalsBlock) {
        systemPrompt += "\n\n---\n\n" + goalsBlock
      }
    } catch {
      // Goal injection is best-effort
    }

    // Call the model
    const startMs = Date.now()
    const usageFile = process.env.MOMO_USAGE_FILE
    const usageSink: Usage[] = []
    const response = await chatComplete({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
      stream: true,
      temperature: 0.7,
      onUsage: (u) => usageSink.push(u),
    })

    // Report token usage to the parent (graph nodes via MOMO_USAGE_FILE).
    if (usageFile && usageSink.length > 0) {
      try {
        const merged: Usage = usageSink.reduce<Usage>(
          (acc, u) => ({
            promptTokens: (acc.promptTokens ?? 0) + (u.promptTokens ?? 0),
            completionTokens: (acc.completionTokens ?? 0) + (u.completionTokens ?? 0),
            totalTokens: (acc.totalTokens ?? 0) + (u.totalTokens ?? 0),
          }),
          {},
        )
        fs.writeFileSync(usageFile, JSON.stringify(merged))
      } catch {
        // best-effort — usage reporting must never break the chat
      }
    }

    // Persist trajectory for /refine and signal mining (best-effort)
    await recordSession({
      provider: config.providerName,
      model: config.model,
      prompt,
      response,
      exitCode: 0,
      durationMs: Date.now() - startMs,
      rlmDepth: Number(process.env.MOMO_RLM_DEPTH || 0) || 0,
    })

    console.error(``) // newline after stream
    return 0
  } catch (err) {
    console.error(``)
    console.error(
      `${MAGENTA}MOMO CODE${RESET} ${RESET}Error: ${err instanceof Error ? err.message : String(err)}${RESET}`,
    )

    // Persist failed trajectories too — they are the most valuable
    // evidence for /refine proposals.
    await recordSession({
      provider: config.providerName,
      model: config.model,
      prompt,
      response: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: 1,
      durationMs: 0,
      rlmDepth: Number(process.env.MOMO_RLM_DEPTH || 0) || 0,
    })

    // Helpful hints for common errors
    const msg = err instanceof Error ? err.message : ""
    if (msg.includes("401") || msg.includes("403")) {
      console.error(`\nHint: Check that your API key is valid and not expired.`)
    } else if (msg.includes("404")) {
      console.error(`\nHint: The model "${config.model}" may not be available.`)
      console.error(`      Try: export MOMO_MODEL=<different-model>`)
    } else if (msg.includes("timed out")) {
      console.error(`\nHint: The model is taking too long. Try again or use a faster model.`)
    }

    return 1
  }
}
