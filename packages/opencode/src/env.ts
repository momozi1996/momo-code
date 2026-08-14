/**
 * Environment variable definitions and accessors for momo Code.
 * All variables use the MOMO_ prefix to avoid collisions with other tools.
 */

import { Effect, Config as EffectConfig } from "effect"
import { Layer } from "effect"

/** Prefix used for all momo Code environment variables. */
export const ENV_PREFIX = "MOMO_"

/**
 * Well-known environment variable names used by momo Code.
 */
export const ENV_NAMES = {
  /** API key for the primary LLM provider. */
  API_KEY: "MOMO_API_KEY",

  /** Base URL override for the LLM provider. */
  BASE_URL: "MOMO_BASE_URL",

  /** Model ID or tier name to use. */
  MODEL: "MOMO_MODEL",

  /** Provider name to use (e.g., 'anthropic', 'openai', 'openrouter'). */
  PROVIDER: "MOMO_PROVIDER",

  /** URL for the model catalog API. */
  MODELS_URL: "MOMO_MODELS_URL",

  /** Debug logging level. */
  DEBUG: "MOMO_DEBUG",

  /** Disable analytics and telemetry. */
  NO_ANALYTICS: "MOMO_NO_ANALYTICS",

  /** Configuration directory override. */
  CONFIG_DIR: "MOMO_CONFIG_DIR",

  /** Claude Code ecosystem inheritance switch. */
  CLAUDE_CODE_INHERIT: "MOMO_CLAUDE_CODE_INHERIT",

  /** Disable Claude Code prompts inheritance. */
  NO_CLAUDE_PROMPTS: "MOMO_NO_CLAUDE_PROMPTS",

  /** Disable Claude Code settings inheritance. */
  NO_CLAUDE_SETTINGS: "MOMO_NO_CLAUDE_SETTINGS",

  /** Enable CC Switch provider inheritance. */
  CC_SWITCH_INHERIT: "MOMO_CC_SWITCH_INHERIT",

  /** Disable CC Switch provider inheritance. */
  NO_CC_SWITCH: "MOMO_NO_CC_SWITCH",

  /** OpenRouter API key. */
  OPENROUTER_API_KEY: "MOMO_OPENROUTER_API_KEY",

  /** Anthropic API key. */
  ANTHROPIC_API_KEY: "MOMO_ANTHROPIC_API_KEY",

  /** OpenAI API key. */
  OPENAI_API_KEY: "MOMO_OPENAI_API_KEY",

  /** Google API key. */
  GOOGLE_API_KEY: "MOMO_GOOGLE_API_KEY",

  /** Groq API key. */
  GROQ_API_KEY: "MOMO_GROQ_API_KEY",

  /** Mistral API key. */
  MISTRAL_API_KEY: "MOMO_MISTRAL_API_KEY",

  /** XAI (Grok) API key. */
  XAI_API_KEY: "MOMO_XAI_API_KEY",

  /** Cohere API key. */
  COHERE_API_KEY: "MOMO_COHERE_API_KEY",

  /** Azure OpenAI API key. */
  AZURE_API_KEY: "MOMO_AZURE_API_KEY",

  /** Azure OpenAI resource name. */
  AZURE_RESOURCE_NAME: "MOMO_AZURE_RESOURCE_NAME",

  /** Bedrock access key ID. */
  BEDROCK_ACCESS_KEY_ID: "MOMO_BEDROCK_ACCESS_KEY_ID",

  /** Bedrock secret access key. */
  BEDROCK_SECRET_ACCESS_KEY: "MOMO_BEDROCK_SECRET_ACCESS_KEY",

  /** Bedrock region. */
  BEDROCK_REGION: "MOMO_BEDROCK_REGION",

  /** NVIDIA API key. */
  NVIDIA_API_KEY: "MOMO_NVIDIA_API_KEY",

  /** Together AI API key. */
  TOGETHER_AI_API_KEY: "MOMO_TOGETHER_AI_API_KEY",

  /** Perplexity API key. */
  PERPLEXITY_API_KEY: "MOMO_PERPLEXITY_API_KEY",

  /** DeepInfra API key. */
  DEEPINFRA_API_KEY: "MOMO_DEEPINFRA_API_KEY",

  /** Cerebras API key. */
  CEREBRAS_API_KEY: "MOMO_CEREBRAS_API_KEY",

  /** Alibaba Cloud API key. */
  ALIBABA_API_KEY: "MOMO_ALIBABA_API_KEY",

  /** Vercel AI API key. */
  VERCEL_AI_API_KEY: "MOMO_VERCEL_AI_API_KEY",

  /** Chunk timeout for streaming responses (ms). */
  CHUNK_TIMEOUT: "MOMO_CHUNK_TIMEOUT",

  /** Default tier when none is specified. */
  DEFAULT_TIER: "MOMO_DEFAULT_TIER",

  /** Force dark mode. */
  DARK_MODE: "MOMO_DARK_MODE",

  /** Session ID for resuming conversations. */
  SESSION_ID: "MOMO_SESSION_ID",

  /** Disable session trajectory recording when set to 'false'. */
  SESSION_RECORD: "MOMO_SESSION_RECORD",

  /** Current subagent recursion depth (set automatically). */
  RLM_DEPTH: "MOMO_RLM_DEPTH",

  /** Maximum subagent recursion depth (default: 3). */
  RLM_MAX_DEPTH: "MOMO_RLM_MAX_DEPTH",

  /** Maximum subagents per orchestration run (default: 8). */
  RLM_BUDGET: "MOMO_RLM_BUDGET",

  /** Per-subagent timeout in ms (default: 300000). */
  RLM_TIMEOUT_MS: "MOMO_RLM_TIMEOUT_MS",

  /** Daemon poll interval in seconds (default: 60). */
  DAEMON_INTERVAL: "MOMO_DAEMON_INTERVAL",

  /** Stop the daemon after N heartbeat passes. */
  DAEMON_MAX_RUNS: "MOMO_DAEMON_MAX_RUNS",

  /** Stop the daemon after N hours (default: 24). */
  DAEMON_MAX_HOURS: "MOMO_DAEMON_MAX_HOURS",

  /** Python executable for the Genesis world server. */
  SIM_PYTHON: "MOMO_SIM_PYTHON",

  /** Override path of the genesis_world server script. */
  SIM_SERVER: "MOMO_SIM_SERVER",

  /** Max LLM control-loop steps for /sim run (default: 20). */
  SIM_MAX_STEPS: "MOMO_SIM_MAX_STEPS",

  /** Genesis backend for simulation: cpu or gpu (default: cpu). */
  SIM_BACKEND: "MOMO_SIM_BACKEND",

  /** Python executable for voice recording. */
  VOICE_PYTHON: "MOMO_VOICE_PYTHON",

  /** Default voice recording length in seconds (default: 5). */
  VOICE_SECONDS: "MOMO_VOICE_SECONDS",

  /** STT (speech-to-text) API key for /voice. */
  STT_API_KEY: "MOMO_STT_API_KEY",

  /** STT base URL (default: https://api.openai.com/v1). */
  STT_BASE_URL: "MOMO_STT_BASE_URL",

  /** STT model (default: whisper-1). */
  STT_MODEL: "MOMO_STT_MODEL",
} as const

/**
 * Typed environment variable accessors.
 */
export class Env extends Effect.Service<Env>()("Env", {
  effect: Effect.gen(function* () {
    const getString = (name: string): Effect.Effect<string | undefined> =>
      Effect.sync(() => process.env[name])

    const getNumber = (name: string): Effect.Effect<number | undefined> =>
      Effect.sync(() => {
        const value = process.env[name]
        if (value === undefined) return undefined
        const parsed = Number(value)
        return Number.isNaN(parsed) ? undefined : parsed
      })

    const getBoolean = (name: string): Effect.Effect<boolean> =>
      Effect.sync(() => {
        const value = process.env[name]
        return value === "1" || value === "true" || value === "yes"
      })

    const requireString = (name: string): Effect.Effect<string, Error> =>
      Effect.gen(function* () {
        const value = yield* getString(name)
        if (value === undefined) {
          return yield* Effect.fail(
            new Error(`Required environment variable ${name} is not set`),
          )
        }
        return value
      })

    return { getString, getNumber, getBoolean, requireString }
  }),
}) {}

/** Live layer for the Env service. */
export const EnvLive = Env.Default
