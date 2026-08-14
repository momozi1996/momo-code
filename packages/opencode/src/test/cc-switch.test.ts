import { describe, it, before, after } from "node:test"
import assert from "node:assert"
import fs from "fs"
import os from "os"
import path from "path"
import {
  getCcSwitchDir,
  getOpencodeConfigPath,
  isCcSwitchInheritanceEnabled,
  loadActiveCcSwitchProvider,
  loadActiveCcSwitchProviderSync,
  loadCcSwitchSettings,
  normalizeCcSwitchProvider,
  normalizeOpencodeProvider,
} from "../provider/cc-switch.js"

describe("cc-switch integration", () => {
  let tmpDir: string
  let originalHomedir: typeof os.homedir
  let originalNoCcSwitch: string | undefined
  let originalCcSwitchInherit: string | undefined
  let originalOpencodeConfigDir: string | undefined

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "momo-cc-switch-"))
    originalHomedir = os.homedir
    os.homedir = () => tmpDir
    originalNoCcSwitch = process.env.MOMO_NO_CC_SWITCH
    originalCcSwitchInherit = process.env.MOMO_CC_SWITCH_INHERIT
    originalOpencodeConfigDir = process.env.OPENCODE_CONFIG_DIR
    delete process.env.MOMO_NO_CC_SWITCH
    delete process.env.MOMO_CC_SWITCH_INHERIT
    delete process.env.OPENCODE_CONFIG_DIR
  })

  after(() => {
    os.homedir = originalHomedir
    if (originalNoCcSwitch !== undefined) {
      process.env.MOMO_NO_CC_SWITCH = originalNoCcSwitch
    } else {
      delete process.env.MOMO_NO_CC_SWITCH
    }
    if (originalCcSwitchInherit !== undefined) {
      process.env.MOMO_CC_SWITCH_INHERIT = originalCcSwitchInherit
    } else {
      delete process.env.MOMO_CC_SWITCH_INHERIT
    }
    if (originalOpencodeConfigDir !== undefined) {
      process.env.OPENCODE_CONFIG_DIR = originalOpencodeConfigDir
    } else {
      delete process.env.OPENCODE_CONFIG_DIR
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("getCcSwitchDir points to ~/.cc-switch under mocked home", () => {
    assert.strictEqual(getCcSwitchDir(), path.join(tmpDir, ".cc-switch"))
  })

  it("isCcSwitchInheritanceEnabled defaults to true and respects env toggles", () => {
    delete process.env.MOMO_NO_CC_SWITCH
    delete process.env.MOMO_CC_SWITCH_INHERIT
    assert.strictEqual(isCcSwitchInheritanceEnabled(), true)

    process.env.MOMO_NO_CC_SWITCH = "true"
    assert.strictEqual(isCcSwitchInheritanceEnabled(), false)
    delete process.env.MOMO_NO_CC_SWITCH

    process.env.MOMO_CC_SWITCH_INHERIT = "false"
    assert.strictEqual(isCcSwitchInheritanceEnabled(), false)
    delete process.env.MOMO_CC_SWITCH_INHERIT
  })

  it("normalizeCcSwitchProvider extracts Anthropic env vars", () => {
    const provider = normalizeCcSwitchProvider({
      id: "uuid",
      app_type: "claude",
      name: "Kimi For Coding",
      settings_config: JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: "sk-kimi",
          ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
          ANTHROPIC_MODEL: "kimi-model",
        },
      }),
      is_current: 1,
    })
    assert.ok(provider)
    assert.strictEqual(provider!.providerName, "anthropic")
    assert.strictEqual(provider!.apiKey, "sk-kimi")
    assert.strictEqual(provider!.baseUrl, "https://api.kimi.com/coding/")
    assert.strictEqual(provider!.model, "kimi-model")
  })

  it("normalizeCcSwitchProvider returns null when API key is missing", () => {
    const provider = normalizeCcSwitchProvider({
      id: "uuid",
      app_type: "claude",
      name: "Broken",
      settings_config: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://x" } }),
      is_current: 1,
    })
    assert.strictEqual(provider, null)
  })

  it("loadCcSwitchSettings parses currentProviderClaude", () => {
    const ccDir = path.join(tmpDir, ".cc-switch")
    fs.mkdirSync(ccDir, { recursive: true })
    fs.writeFileSync(
      path.join(ccDir, "settings.json"),
      JSON.stringify({ currentProviderClaude: "abc-123" }),
    )
    const settings = loadCcSwitchSettings()
    assert.ok(settings)
    assert.strictEqual(settings!.currentProviderClaude, "abc-123")
  })

  it("loadActiveCcSwitchProviderSync falls back to Claude Code settings", () => {
    const claudeDir = path.join(tmpDir, ".claude")
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: "sk-fallback",
          ANTHROPIC_BASE_URL: "http://localhost:8080",
        },
      }),
    )
    const provider = loadActiveCcSwitchProviderSync("claude")
    assert.ok(provider)
    assert.strictEqual(provider!.apiKey, "sk-fallback")
    assert.strictEqual(provider!.baseUrl, "http://localhost:8080")
  })

  it("loadActiveCcSwitchProviderSync returns null when disabled", () => {
    process.env.MOMO_NO_CC_SWITCH = "true"
    const provider = loadActiveCcSwitchProviderSync("claude")
    assert.strictEqual(provider, null)
    delete process.env.MOMO_NO_CC_SWITCH
  })

  it("getOpencodeConfigPath points to ~/.config/opencode/opencode.json", () => {
    assert.strictEqual(
      getOpencodeConfigPath(),
      path.join(tmpDir, ".config", "opencode", "opencode.json"),
    )
  })

  it("normalizeOpencodeProvider extracts opencode provider fields", () => {
    const provider = normalizeOpencodeProvider({
      id: "op-id",
      app_type: "opencode",
      name: "Kimi",
      settings_config: JSON.stringify({
        npm: "@ai-sdk/openai-compatible",
        name: "Kimi For Coding",
        options: {
          baseURL: "https://api.kimi.com/coding/v1",
          apiKey: "sk-kimi-opencode",
        },
        models: {
          "kimi-k2": { name: "Kimi K2" },
        },
      }),
      is_current: 1,
    })
    assert.ok(provider)
    assert.strictEqual(provider!.providerName, "openai")
    assert.strictEqual(provider!.apiKey, "sk-kimi-opencode")
    assert.strictEqual(provider!.baseUrl, "https://api.kimi.com/coding/v1")
    assert.strictEqual(provider!.model, "kimi-k2")
  })

  it("normalizeOpencodeProvider maps @ai-sdk/anthropic to anthropic", () => {
    const provider = normalizeOpencodeProvider({
      id: "op-ant",
      app_type: "opencode",
      name: "Claude",
      settings_config: JSON.stringify({
        npm: "@ai-sdk/anthropic",
        options: {
          baseURL: "https://api.anthropic.com",
          apiKey: "sk-ant-opencode",
        },
        models: { "claude-sonnet-4": { name: "Claude Sonnet 4" } },
      }),
      is_current: 1,
    })
    assert.ok(provider)
    assert.strictEqual(provider!.providerName, "anthropic")
    assert.strictEqual(provider!.apiKey, "sk-ant-opencode")
    assert.strictEqual(provider!.model, "claude-sonnet-4")
  })

  it("normalizeOpencodeProvider unwraps a top-level provider key", () => {
    const provider = normalizeOpencodeProvider({
      id: "op-wrapped",
      app_type: "opencode",
      name: "DeepSeek",
      settings_config: JSON.stringify({
        provider: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://api.deepseek.com/v1", apiKey: "sk-ds" },
          models: { "deepseek-v4": { name: "DeepSeek V4" } },
        },
      }),
      is_current: 1,
    })
    assert.ok(provider)
    assert.strictEqual(provider!.providerName, "openai")
    assert.strictEqual(provider!.apiKey, "sk-ds")
    assert.strictEqual(provider!.model, "deepseek-v4")
  })

  it("normalizeOpencodeProvider returns null when API key is missing", () => {
    const provider = normalizeOpencodeProvider({
      id: "op-broken",
      app_type: "opencode",
      name: "Broken",
      settings_config: JSON.stringify({
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://x" },
      }),
      is_current: 1,
    })
    assert.strictEqual(provider, null)
  })

  it("loadActiveCcSwitchProviderSync reads the current opencode provider from the live config", () => {
    const ccDir = path.join(tmpDir, ".cc-switch")
    fs.mkdirSync(ccDir, { recursive: true })
    fs.writeFileSync(
      path.join(ccDir, "settings.json"),
      JSON.stringify({ currentProviderOpencode: "kimi" }),
    )
    const opencodeDir = path.join(tmpDir, ".config", "opencode")
    fs.mkdirSync(opencodeDir, { recursive: true })
    fs.writeFileSync(
      path.join(opencodeDir, "opencode.json"),
      JSON.stringify({
        provider: {
          kimi: {
            npm: "@ai-sdk/openai-compatible",
            name: "Kimi",
            options: {
              baseURL: "https://api.kimi.com/coding/v1",
              apiKey: "sk-live",
            },
            models: { "kimi-k2": { name: "Kimi K2" } },
          },
          other: {
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: "https://other.example.com/v1",
              apiKey: "sk-other",
            },
          },
        },
      }),
    )
    const provider = loadActiveCcSwitchProviderSync("opencode")
    assert.ok(provider)
    assert.strictEqual(provider!.id, "kimi")
    assert.strictEqual(provider!.name, "Kimi")
    assert.strictEqual(provider!.apiKey, "sk-live")
    assert.strictEqual(provider!.model, "kimi-k2")
  })

  it("loadActiveCcSwitchProvider resolves opencode from the live config (async)", async () => {
    const provider = await loadActiveCcSwitchProvider("opencode")
    assert.ok(provider)
    assert.strictEqual(provider!.id, "kimi")
    assert.strictEqual(provider!.apiKey, "sk-live")
  })

  it("loadActiveCcSwitchProviderSync parses JSON5 opencode.json and auto-picks a single provider", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".cc-switch", "settings.json"),
      JSON.stringify({}),
    )
    const opencodeDir = path.join(tmpDir, ".config", "opencode")
    fs.mkdirSync(opencodeDir, { recursive: true })
    fs.writeFileSync(
      path.join(opencodeDir, "opencode.json"),
      [
        "{",
        "  // opencode JSON5 config",
        '  "provider": {',
        '    "deepseek": {',
        '      "npm": "@ai-sdk/openai-compatible",',
        '      "options": { "baseURL": "https://api.deepseek.com/v1", "apiKey": "sk-ds" },',
        '      "models": { "deepseek-v4": { "name": "DeepSeek V4" } },',
        "    },",
        "  },",
        "}",
      ].join("\n"),
    )
    const provider = loadActiveCcSwitchProviderSync("opencode")
    assert.ok(provider)
    assert.strictEqual(provider!.id, "deepseek")
    assert.strictEqual(provider!.apiKey, "sk-ds")
    assert.strictEqual(provider!.model, "deepseek-v4")
  })

  it("loadActiveCcSwitchProviderSync returns null when multiple opencode providers exist without a current id", () => {
    fs.writeFileSync(
      path.join(tmpDir, ".cc-switch", "settings.json"),
      JSON.stringify({}),
    )
    fs.writeFileSync(
      path.join(tmpDir, ".config", "opencode", "opencode.json"),
      JSON.stringify({
        provider: {
          a: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://a/v1", apiKey: "sk-a" },
          },
          b: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://b/v1", apiKey: "sk-b" },
          },
        },
      }),
    )
    assert.strictEqual(loadActiveCcSwitchProviderSync("opencode"), null)
  })

  it("loadActiveCcSwitchProvider reads the sole opencode row from the SQLite DB", async (t) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let DatabaseSync: any
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      DatabaseSync = (await import("node:sqlite"))?.DatabaseSync
    } catch {
      t.skip("node:sqlite not available")
      return
    }

    // No live config and no currentProviderOpencode: the DB row is the source.
    fs.writeFileSync(
      path.join(tmpDir, ".cc-switch", "settings.json"),
      JSON.stringify({}),
    )
    const livePath = path.join(tmpDir, ".config", "opencode", "opencode.json")
    if (fs.existsSync(livePath)) fs.rmSync(livePath)

    const db = new DatabaseSync(path.join(tmpDir, ".cc-switch", "cc-switch.db"))
    db.exec(`
      CREATE TABLE providers (
        id TEXT NOT NULL,
        app_type TEXT NOT NULL,
        name TEXT NOT NULL,
        settings_config TEXT NOT NULL,
        is_current BOOLEAN NOT NULL DEFAULT 0,
        PRIMARY KEY (id, app_type)
      )
    `)
    db.prepare(
      "INSERT INTO providers (id, app_type, name, settings_config, is_current) VALUES (?, ?, ?, ?, ?)",
    ).run(
      "deepseek",
      "opencode",
      "DeepSeek",
      JSON.stringify({
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://api.deepseek.com/v1", apiKey: "sk-db" },
        models: { "deepseek-v4-flash": { name: "DeepSeek Flash" } },
      }),
      0,
    )
    db.close()

    const provider = await loadActiveCcSwitchProvider("opencode")
    assert.ok(provider)
    assert.strictEqual(provider!.id, "deepseek")
    assert.strictEqual(provider!.providerName, "openai")
    assert.strictEqual(provider!.apiKey, "sk-db")
    assert.strictEqual(provider!.model, "deepseek-v4-flash")
  })

  it("loadActiveCcSwitchProviderSync returns null for opencode when disabled", () => {
    process.env.MOMO_NO_CC_SWITCH = "true"
    const provider = loadActiveCcSwitchProviderSync("opencode")
    assert.strictEqual(provider, null)
    delete process.env.MOMO_NO_CC_SWITCH
  })
})