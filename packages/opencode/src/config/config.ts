/**
 * Configuration system for momo Code.
 * Manages loading and merging of configuration from files, environment variables,
 * and CLI arguments. Replaces .opencode/ with .momo/ paths.
 */

import { Effect, Config as EffectConfig, Layer } from "effect"
import os from "os"
import path from "path"
import fs from "fs"
import { loadActiveCcSwitchProvider } from "../provider/cc-switch.js"

/** Configuration directory name for momo Code. */
export const CONFIG_DIR_NAME = ".momo"

/** Configuration file name. */
export const CONFIG_FILE_NAME = "momo.jsonc"

/** Session subdirectory name. */
export const SESSION_DIR_NAME = "sessions"

/** Claude Code config directory name. */
export const CLAUDE_CODE_DIR_NAME = ".claude"

/**
 * Get the default configuration directory path.
 * Uses MOMO_CONFIG_DIR if set, otherwise ~/.momo/
 */
export function getConfigDir(): string {
  return process.env.MOMO_CONFIG_DIR || path.join(os.homedir(), CONFIG_DIR_NAME)
}

/**
 * Get the path to the main configuration file.
 */
export function getConfigFilePath(): string {
  return path.join(getConfigDir(), CONFIG_FILE_NAME)
}

/**
 * Get the sessions directory path.
 */
export function getSessionsDir(): string {
  return path.join(getConfigDir(), SESSION_DIR_NAME)
}

/**
 * Get the Claude Code configuration directory path (for inheritance).
 */
export function getClaudeCodeDir(): string {
  return path.join(os.homedir(), CLAUDE_CODE_DIR_NAME)
}

/**
 * User configuration shape for momo Code.
 */
export interface UserConfig {
  /** Default model ID or tier to use. */
  readonly model?: string

  /** Default provider to use. */
  readonly provider?: string

  /** API key (prefer MOMO_API_KEY env var). */
  readonly apiKey?: string

  /** Base URL override for the provider. */
  readonly baseUrl?: string

  /** Whether to inherit Claude Code configuration. */
  readonly inheritClaudeCode?: boolean

  /** Whether to inherit Claude Code prompts. */
  readonly inheritClaudePrompts?: boolean

  /** Whether to inherit Claude Code settings. */
  readonly inheritClaudeSettings?: boolean

  /** Whether to inherit CC Switch active provider configuration. */
  readonly inheritCcSwitch?: boolean

  /** Theme setting. */
  readonly theme?: "dark" | "light" | "system"

  /** Analytics enabled. */
  readonly analytics?: boolean

  /** Default tier preference. */
  readonly tier?: "ultra" | "standard" | "lite"

  /** Provider-specific overrides. */
  readonly providers?: Record<
    string,
    {
      readonly apiKey?: string
      readonly baseUrl?: string
      readonly defaultModel?: string
      readonly headers?: Record<string, string>
    }
  >

  /** Custom model aliases. */
  readonly modelAliases?: Record<string, string>

  /** Editor preference. */
  readonly editor?: string

  /** Shell preference. */
  readonly shell?: string

  /** Enable experimental features. */
  readonly experimental?: Record<string, boolean>
}

/**
 * Load the user configuration from the config file.
 * Returns default config if the file does not exist.
 */
export function loadUserConfig(): Effect.Effect<UserConfig, Error> {
  return Effect.gen(function* () {
    const configPath = getConfigFilePath()
    const exists = yield* Effect.sync(() => fs.existsSync(configPath))

    if (!exists) {
      return {}
    }

    const content = yield* Effect.tryPromise({
      try: () => fs.promises.readFile(configPath, "utf-8"),
      catch: (error) =>
        new Error(
          `Failed to read config file: ${error instanceof Error ? error.message : String(error)}`,
        ),
    })

    // Strip JSONC comments before parsing
    const stripped = content
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")

    try {
      const parsed = JSON.parse(stripped) as UserConfig
      return parsed
    } catch {
      return {}
    }
  })
}

/**
 * Determine whether CC Switch inheritance is enabled.
 * Order of precedence: env > user config > default (true).
 */
function isCcSwitchEnabled(config: UserConfig): boolean {
  if (process.env.MOMO_NO_CC_SWITCH === "true") return false
  if (process.env.MOMO_CC_SWITCH_INHERIT === "false") return false
  if (config.inheritCcSwitch === false) return false
  return true
}

/**
 * Ensure the configuration directory exists.
 */
export function ensureConfigDir(): Effect.Effect<void, Error> {
  return Effect.tryPromise({
    try: () =>
      fs.promises.mkdir(getConfigDir(), { recursive: true }),
    catch: (error) =>
      new Error(
        `Failed to create config directory: ${error instanceof Error ? error.message : String(error)}`,
      ),
  })
}

/**
 * Configuration service for momo Code.
 * Provides typed access to merged configuration values.
 */
export class Config extends Effect.Service<Config>()("Config", {
  effect: Effect.gen(function* () {
    let userConfig = yield* loadUserConfig()

    // Merge CC Switch active provider into config (momo.jsonc still wins).
    // momo is opencode-based, so the opencode provider takes precedence over
    // the claude provider when both are configured in CC Switch.
    if (isCcSwitchEnabled(userConfig)) {
      for (const appType of ["opencode", "claude"] as const) {
        const ccProvider = yield* Effect.promise(() =>
          loadActiveCcSwitchProvider(appType),
        )
        if (!ccProvider) continue
        const existing = userConfig.providers?.[ccProvider.providerName] || {}
        userConfig = {
          ...userConfig,
          provider: userConfig.provider || ccProvider.providerName,
          model: userConfig.model || ccProvider.model,
          providers: {
            ...userConfig.providers,
            [ccProvider.providerName]: {
              ...existing,
              apiKey: existing.apiKey || ccProvider.apiKey,
              baseUrl: existing.baseUrl || ccProvider.baseUrl,
              defaultModel: existing.defaultModel || ccProvider.model,
            },
          },
        }
        break
      }
    }

    /** Get a config value with fallback. */
    const get = <T>(
      key: keyof UserConfig,
      fallback: T,
    ): Effect.Effect<T> => {
      return Effect.sync(() => {
        const value = userConfig[key]
        return value !== undefined ? (value as T) : fallback
      })
    }

    /** Get an optional config value. */
    const getOptional = <T>(
      key: keyof UserConfig,
    ): Effect.Effect<T | undefined> => {
      return Effect.sync(() => userConfig[key] as T | undefined)
    }

    /** Get provider-specific configuration. */
    const getProviderConfig = (
      providerName: string,
    ): Effect.Effect<
      NonNullable<UserConfig["providers"]>[string] | undefined
    > => {
      return Effect.sync(() => userConfig.providers?.[providerName])
    }

    /** Get the raw user config object. */
    const getRaw = Effect.sync(() => userConfig)

    return {
      get,
      getOptional,
      getProviderConfig,
      getRaw,
      userConfig,
    }
  }),
  dependencies: [],
}) {}

/** Default live layer for the Config service. */
export const ConfigLive = Config.Default
