/**
 * CC Switch integration for momo Code.
 *
 * CC Switch (github.com/farion1231/cc-switch) is a desktop GUI for managing
 * provider configurations for Claude Code, Codex, Gemini CLI, opencode, etc.
 * This module reads the active provider for the "claude" and "opencode" app
 * types and exposes it as a normal momo provider config so users can switch
 * providers in CC Switch and have momo follow automatically.
 *
 * Resolution strategy (claude):
 *   1. Read ~/.cc-switch/settings.json to find the current provider ID.
 *   2. Query ~/.cc-switch/cc-switch.db (SQLite) for that provider.
 *   3. If SQLite is unavailable, fall back to ~/.claude/settings.json, which
 *      CC Switch rewrites with the active provider's ANTHROPIC_* env vars.
 *
 * Resolution strategy (opencode):
 *   momo is opencode-based, so the live opencode config
 *   (~/.config/opencode/opencode.json) is the primary source — CC Switch
 *   merges every opencode provider into its additive "provider" map. The
 *   current provider ID comes from CC Switch settings.json
 *   (currentProviderOpencode); when that is missing we fall back to the
 *   SQLite is_current flag, then to the sole opencode row (CC Switch does
 *   not maintain is_current for the additive opencode mode), then to the
 *   live file when it contains exactly one usable provider.
 */

import fs from "fs"
import os from "os"
import path from "path"

/**
 * Normalized provider config extracted from CC Switch.
 */
export interface CcSwitchProvider {
  /** CC Switch provider UUID. */
  readonly id: string
  /** Display name from CC Switch. */
  readonly name: string
  /** App type, e.g. "claude" or "opencode". */
  readonly appType: string
  /** momo provider name to use (CC Switch/Claude Code is Anthropic protocol). */
  readonly providerName: string
  /** API key / auth token. */
  readonly apiKey: string
  /** Base URL override. */
  readonly baseUrl?: string
  /** Default model if specified. */
  readonly model?: string
}

/** Parsed CC Switch settings.json. */
export interface CcSwitchSettings {
  readonly currentProviderClaude?: string
  readonly currentProviderCodex?: string
  readonly currentProviderGemini?: string
  readonly currentProviderOpencode?: string
}

/** Raw row from the CC Switch providers table. */
interface CcSwitchProviderRow {
  readonly id: string
  readonly app_type: string
  readonly name: string
  readonly settings_config: string
  readonly is_current: number | boolean
}

/**
 * A provider entry from opencode's live config file
 * (~/.config/opencode/opencode.json → "provider" map).
 */
export interface OpencodeProviderEntry {
  /** AI SDK provider package, e.g. @ai-sdk/openai-compatible. */
  readonly npm?: string
  /** Display name of the provider. */
  readonly name?: string
  readonly options?: {
    readonly baseURL?: string
    readonly baseUrl?: string
    readonly apiKey?: string
    [key: string]: unknown
  }
  /** Model ID → model metadata map. */
  readonly models?: Record<
    string,
    { readonly name?: string; [key: string]: unknown }
  >
  [key: string]: unknown
}

/** Provider fields extracted from an opencode provider entry. */
type OpencodeExtracted = Pick<
  CcSwitchProvider,
  "providerName" | "apiKey" | "baseUrl" | "model"
>

/** Returns the CC Switch config directory (usually ~/.cc-switch). */
export function getCcSwitchDir(): string {
  return path.join(os.homedir(), ".cc-switch")
}

/**
 * Path to the live opencode config that CC Switch manages.
 * Honors the OPENCODE_CONFIG_DIR env var used by opencode itself.
 */
export function getOpencodeConfigPath(): string {
  const dir = process.env.OPENCODE_CONFIG_DIR
    ? process.env.OPENCODE_CONFIG_DIR
    : path.join(os.homedir(), ".config", "opencode")
  return path.join(dir, "opencode.json")
}

/** Check whether CC Switch inheritance is enabled via env/config. */
export function isCcSwitchInheritanceEnabled(): boolean {
  if (process.env.MOMO_NO_CC_SWITCH === "true") return false
  if (process.env.MOMO_CC_SWITCH_INHERIT === "false") return false
  return true
}

/** Load and parse ~/.cc-switch/settings.json. */
export function loadCcSwitchSettings(): CcSwitchSettings | null {
  const settingsPath = path.join(getCcSwitchDir(), "settings.json")
  if (!fs.existsSync(settingsPath)) return null
  try {
    const content = fs.readFileSync(settingsPath, "utf-8")
    return JSON.parse(content) as CcSwitchSettings
  } catch {
    return null
  }
}

/**
 * Resolve the active CC Switch provider for the given app type.
 * Supports "claude" (Anthropic-compatible) and "opencode" (momo's native
 * config). Defaults to "claude".
 */
export async function loadActiveCcSwitchProvider(
  appType = "claude",
): Promise<CcSwitchProvider | null> {
  if (!isCcSwitchInheritanceEnabled()) return null

  const settings = loadCcSwitchSettings()
  const currentId = settings
    ? settings[`currentProvider${capitalize(appType)}` as keyof CcSwitchSettings]
    : undefined

  // opencode uses the live config file as its source of truth.
  if (appType === "opencode") {
    return loadActiveOpencodeProvider(currentId)
  }

  if (typeof currentId !== "string") {
    // No explicit current provider in settings; try the is_current flag in DB.
    const fromDb = await loadProviderFromDb(appType)
    if (fromDb) return normalizeCcSwitchProvider(fromDb)
    return loadActiveProviderFromClaudeSettings(appType)
  }

  // Try to load the specific provider ID from the DB.
  const fromDb = await loadProviderFromDb(appType, currentId)
  if (fromDb) return normalizeCcSwitchProvider(fromDb)

  // Fallback to Claude Code settings (rewritten by CC Switch).
  return loadActiveProviderFromClaudeSettings(appType)
}

/**
 * Synchronous version that does not touch SQLite. For "claude" it reads
 * ~/.claude/settings.json; for "opencode" it reads the live opencode.json
 * (SQLite fallback is skipped). Useful where async is not available.
 */
export function loadActiveCcSwitchProviderSync(
  appType = "claude",
): CcSwitchProvider | null {
  if (!isCcSwitchInheritanceEnabled()) return null
  if (appType === "opencode") {
    const settings = loadCcSwitchSettings()
    return resolveOpencodeFromLive(settings?.currentProviderOpencode)
  }
  return loadActiveProviderFromClaudeSettings(appType)
}

/**
 * Normalize a raw CC Switch provider row into momo provider config.
 * Returns null if the row does not contain a usable API key.
 */
export function normalizeCcSwitchProvider(
  row: CcSwitchProviderRow,
): CcSwitchProvider | null {
  let config: { env?: Record<string, string> } = {}
  try {
    config = JSON.parse(row.settings_config) as { env?: Record<string, string> }
  } catch {
    return null
  }

  const env = config.env || {}
  const apiKey = env.ANTHROPIC_AUTH_TOKEN
  if (!apiKey) return null

  const baseUrl = env.ANTHROPIC_BASE_URL
  const model =
    env.ANTHROPIC_MODEL ||
    env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
    env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL

  return {
    id: row.id,
    name: row.name,
    appType: row.app_type,
    providerName: "anthropic",
    apiKey,
    baseUrl,
    model,
  }
}

/**
 * Normalize a raw CC Switch opencode provider row into momo provider config.
 * Returns null if the row does not contain a usable API key.
 */
export function normalizeOpencodeProvider(
  row: CcSwitchProviderRow,
): CcSwitchProvider | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.settings_config)
  } catch {
    return null
  }

  // settings_config may store the provider entry directly or wrapped under a
  // "provider" key (mirroring opencode.json's top-level shape).
  let entry: OpencodeProviderEntry | undefined
  if (isOpencodeProviderEntry(parsed)) {
    entry = parsed
  } else if (
    parsed !== null &&
    typeof parsed === "object" &&
    isOpencodeProviderEntry((parsed as { provider?: unknown }).provider)
  ) {
    entry = (parsed as { provider?: OpencodeProviderEntry }).provider
  }
  if (!entry) return null

  const extracted = extractOpencodeEntry(entry)
  if (!extracted) return null

  return {
    id: row.id,
    name: row.name || entry.name || row.id,
    appType: row.app_type,
    ...extracted,
  }
}

/** True when the value looks like an opencode provider entry. */
function isOpencodeProviderEntry(
  value: unknown,
): value is OpencodeProviderEntry {
  return (
    value !== null &&
    typeof value === "object" &&
    ("npm" in value || "options" in value || "models" in value)
  )
}

/** Extract momo provider fields from an opencode provider entry. */
function extractOpencodeEntry(
  entry: OpencodeProviderEntry,
): OpencodeExtracted | null {
  const options = entry.options || {}
  const apiKey = options.apiKey
  if (!apiKey) return null

  const models = entry.models
  const model = models ? Object.keys(models)[0] : undefined

  return {
    providerName: mapOpencodeNpmToProvider(entry.npm),
    apiKey,
    baseUrl: options.baseURL || options.baseUrl,
    model,
  }
}

/**
 * Map an opencode AI SDK npm package to the closest momo provider.
 * momo talks to OpenAI-compatible /chat/completions endpoints, so most
 * openai-compatible SDK packages resolve to the "openai" provider slot.
 */
function mapOpencodeNpmToProvider(npm?: string): string {
  if (!npm) return "openai"
  const pkg = npm.toLowerCase()
  if (pkg.includes("anthropic")) return "anthropic"
  if (pkg.includes("google")) return "google"
  return "openai"
}

/** Internal: read provider rows from the SQLite DB. */
async function loadProviderRowsFromDb(
  appType: string,
  providerId?: string,
  includeAll = false,
): Promise<CcSwitchProviderRow[]> {
  const dbPath = path.join(getCcSwitchDir(), "cc-switch.db")
  if (!fs.existsSync(dbPath)) return []

  // Try Bun's built-in SQLite first (compiled binary / Bun runtime).
  try {
    const bunSqlite = "bun:sqlite"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Database }: any = await import(bunSqlite)
    const db = new Database(dbPath, { readonly: true })
    try {
      let sql =
        "SELECT id, app_type, name, settings_config, is_current FROM providers WHERE app_type = ?"
      const params: (string | number)[] = [appType]
      if (providerId) {
        sql += " AND id = ?"
        params.push(providerId)
      } else if (!includeAll) {
        sql += " AND is_current = 1"
      }
      const stmt = db.query(sql)
      return (stmt.all(...params) as CcSwitchProviderRow[]) || []
    } finally {
      db.close()
    }
  } catch {
    // fallthrough
  }

  // Try Node's built-in SQLite (Node 22.5+; no native dependency needed).
  try {
    const nodeSqlite = "node:sqlite"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { DatabaseSync }: any = await import(nodeSqlite)
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      let sql =
        "SELECT id, app_type, name, settings_config, is_current FROM providers WHERE app_type = ?"
      const params: (string | number)[] = [appType]
      if (providerId) {
        sql += " AND id = ?"
        params.push(providerId)
      } else if (!includeAll) {
        sql += " AND is_current = 1"
      }
      const stmt = db.prepare(sql)
      return (stmt.all(...params) as CcSwitchProviderRow[]) || []
    } finally {
      db.close()
    }
  } catch {
    // fallthrough
  }

  // Try better-sqlite3 for Node runtimes.
  try {
    const betterSqlite = "better-sqlite3"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { default: Database }: any = await import(betterSqlite)
    const db = new Database(dbPath, { readonly: true })
    try {
      let sql =
        "SELECT id, app_type, name, settings_config, is_current FROM providers WHERE app_type = ?"
      const params: string[] = [appType]
      if (providerId) {
        sql += " AND id = ?"
        params.push(providerId)
      } else if (!includeAll) {
        sql += " AND is_current = 1"
      }
      const stmt = db.prepare(sql)
      return (stmt.all(...params) as CcSwitchProviderRow[]) || []
    } finally {
      db.close()
    }
  } catch {
    // fallthrough
  }

  return []
}

/** Internal: try to read the active provider from the SQLite DB. */
async function loadProviderFromDb(
  appType: string,
  providerId?: string,
): Promise<CcSwitchProviderRow | null> {
  const rows = await loadProviderRowsFromDb(appType, providerId)
  return rows[0] || null
}

/** Internal: fall back to ~/.claude/settings.json (rewritten by CC Switch). */
function loadActiveProviderFromClaudeSettings(
  appType: string,
): CcSwitchProvider | null {
  if (appType !== "claude") return null

  const claudeSettingsPath = path.join(os.homedir(), ".claude", "settings.json")
  if (!fs.existsSync(claudeSettingsPath)) return null

  try {
    const content = JSON.parse(
      fs.readFileSync(claudeSettingsPath, "utf-8"),
    ) as { env?: Record<string, string> }
    const env = content.env || {}
    const apiKey = env.ANTHROPIC_AUTH_TOKEN
    if (!apiKey) return null

    return {
      id: "cc-switch-fallback",
      name: "CC Switch (via Claude Code settings)",
      appType: "claude",
      providerName: "anthropic",
      apiKey,
      baseUrl: env.ANTHROPIC_BASE_URL,
      model:
        env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    }
  } catch {
    return null
  }
}

/**
 * Resolve the active opencode provider: explicit current ID from settings
 * (live file, then SQLite), else the SQLite is_current flag, else a single
 * unambiguous provider from the live file.
 */
async function loadActiveOpencodeProvider(
  currentId: string | undefined,
): Promise<CcSwitchProvider | null> {
  if (typeof currentId === "string") {
    const fromLive = resolveOpencodeFromLive(currentId)
    if (fromLive) return fromLive
    const fromDb = await loadProviderFromDb("opencode", currentId)
    if (fromDb) return normalizeOpencodeProvider(fromDb)
    return null
  }

  // No explicit current provider: prefer the DB is_current flag, then the
  // sole opencode row (CC Switch does not maintain is_current for the
  // additive opencode mode), then a single usable live provider.
  const fromDb = await loadProviderFromDb("opencode")
  if (fromDb) return normalizeOpencodeProvider(fromDb)

  const rows = await loadProviderRowsFromDb("opencode", undefined, true)
  if (rows.length === 1) {
    const normalized = normalizeOpencodeProvider(rows[0])
    if (normalized) return normalized
  }

  return resolveOpencodeFromLive()
}

/**
 * Resolve a provider from the live opencode.json. With an explicit provider
 * ID the matching entry is used; otherwise only a single usable provider is
 * unambiguous enough to auto-select.
 */
function resolveOpencodeFromLive(
  currentId?: string,
): CcSwitchProvider | null {
  const liveProviders = loadOpencodeProvidersFromLiveFile()
  if (!liveProviders) return null

  if (typeof currentId === "string") {
    const entry = liveProviders[currentId]
    if (!entry) return null
    const extracted = extractOpencodeEntry(entry)
    if (!extracted) return null
    return {
      id: currentId,
      name: entry.name || currentId,
      appType: "opencode",
      ...extracted,
    }
  }

  const candidates: Array<{
    id: string
    entry: OpencodeProviderEntry
    extracted: OpencodeExtracted
  }> = []
  for (const [id, entry] of Object.entries(liveProviders)) {
    const extracted = extractOpencodeEntry(entry)
    if (extracted) candidates.push({ id, entry, extracted })
  }
  if (candidates.length !== 1) return null

  const { id, entry, extracted } = candidates[0]
  return {
    id,
    name: entry.name || id,
    appType: "opencode",
    ...extracted,
  }
}

/** Read the "provider" map from the live opencode.json (JSON5 tolerant). */
function loadOpencodeProvidersFromLiveFile(): Record<
  string,
  OpencodeProviderEntry
> | null {
  const configPath = getOpencodeConfigPath()
  if (!fs.existsSync(configPath)) return null
  try {
    const content = fs.readFileSync(configPath, "utf-8")
    const parsed = parseJson5Loose(content) as {
      provider?: Record<string, OpencodeProviderEntry>
    }
    if (!parsed || typeof parsed !== "object" || !parsed.provider) return null
    return parsed.provider
  } catch {
    return null
  }
}

/**
 * Parse opencode.json, which allows JSON5 syntax (comments and trailing
 * commas). Tries strict JSON first, then strips comments and trailing commas.
 */
function parseJson5Loose(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    // Best-effort JSON5: strip line comments (but not "://" in URLs), block
    // comments, and trailing commas before a closing bracket.
    const stripped = content
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,(\s*[}\]])/g, "$1")
    return JSON.parse(stripped)
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}