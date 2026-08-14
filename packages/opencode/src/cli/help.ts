/**
 * Shared help text renderer for the momo CLI.
 *
 * Used by both the compiled binary entry point (`src/cli/main.ts`) and the
 * Node.js command router (`src/cli/index.ts`) so the help banner stays
 * consistent across distribution channels.
 */

import { renderBanner } from "./banner.js"

const C = {
  b: "\x1b[1m",
  B: "\x1b[0m",
  c: "\x1b[36m",
  g: "\x1b[32m",
  y: "\x1b[33m",
}
const DIM = "\x1b[37m"
const RESET = "\x1b[0m"

/**
 * Render the full CLI help message, including the banner, usage, commands,
 * examples, environment variables, and quick-start steps.
 */
export function renderHelp(): string {
  const lines: string[] = []

  lines.push(renderBanner())
  lines.push("")
  lines.push(`${C.b}DESCRIPTION:${C.B}`)
  lines.push(`  momo Code is an AI coding agent that evolves with your codebase.`)
  lines.push(`  Start a chat, run the experience fast loop, or trigger self-evolution.`)
  lines.push("")
  lines.push(`${C.b}USAGE:${C.B}`)
  lines.push(`  ${C.c}momo <prompt>${C.B}                Start a coding session`)
  lines.push(`  ${C.c}momo /evolve${C.B}                 Run experience fast loop (KEP)`)
  lines.push(`  ${C.c}momo /fine-tune <subcommand>${C.B} Run self-evolution training (MCGS)`)
  lines.push(`  ${C.c}momo /refine${C.B}                 Evidence-driven self-improvement proposals`)
  lines.push(`  ${C.c}momo /agent \"<task>\"${C.B}         Recursive subagent orchestration (RLM)`)
  lines.push(`  ${C.c}momo /graph <subcommand>${C.B}    Multi-subagent Graph Engine (long-horizon)`)
  lines.push(`  ${C.c}momo /goal <subcommand>${C.B}      Persistent long-term goals`)
  lines.push(`  ${C.c}momo /schedule <subcommand>${C.B}  Timed tasks for heartbeat/daemon`)
  lines.push(`  ${C.c}momo /heartbeat${C.B}              Run one periodic maintenance pass`)
  lines.push(`  ${C.c}momo /daemon${C.B}                 Long-running scheduled-work loop`)
  lines.push(`  ${C.c}momo /sim <subcommand>${C.B}       Genesis world simulation agent`)
  lines.push(`  ${C.c}momo /voice [--seconds=5]${C.B}    Voice input: record → transcribe → run`)
  lines.push(`  ${C.c}momo /optim <subcommand>${C.B}     Reasoning-driven parameter optimization`)
  lines.push(`  ${C.c}momo serve [--port=4097]${C.B}     Local API server + dashboard`)
  lines.push(`  ${C.c}momo models${C.B}                  List available models & providers`)
  lines.push(`  ${C.c}momo help${C.B}                    Show this help message`)
  lines.push(`  ${C.c}momo --version${C.B}               Show version`)
  lines.push("")
  lines.push(`${C.b}EVOLVE COMMANDS:${C.B}`)
  lines.push(`  ${C.c}/evolve${C.B}                       Shortcut for the experience fast loop`)
  lines.push(`  ${C.c}/fine-tune run${C.B}                Start the MCGS self-evolution loop`)
  lines.push(`  ${C.c}/fine-tune status${C.B}             Check the current fine-tuning job`)
  lines.push(`  ${C.c}/fine-tune promote <jobId>${C.B}  Promote a staged model to production`)
  lines.push(`  ${C.c}/fine-tune rollback${C.B}           Roll back to the previous production model`)
  lines.push(`  ${C.c}/fine-tune eval [modelId]${C.B}   Run evaluation only (no training)`)
  lines.push("")
  lines.push(`${C.b}AGENT COMMANDS:${C.B}`)
  lines.push(`  ${C.c}/refine [--last=N]${C.B}            Review recent sessions → propose improvements`)
  lines.push(`  ${C.c}/refine approve|apply <id>${C.B}  Human-review gate (nothing auto-applies)`)
  lines.push(`  ${C.c}/agent \"<task>\"${C.B}             Decompose → parallel subagents → synthesize`)
  lines.push(`  ${C.c}/graph run|resume|approve|reject|status|list${C.B} DAG of subagents, resumable long-horizon runs`)
  lines.push(`  ${C.c}/goal add|list|log|done${C.B}     Track goals injected into every session`)
  lines.push(`  ${C.c}/schedule add --every=60m${C.B}   Timed subagent tasks`)
  lines.push(`  ${C.c}/heartbeat${C.B}                  Run due tasks + goal check-in`)
  lines.push(`  ${C.c}/daemon [--interval=60]${C.B}     Foreground loop (budget: MOMO_DAEMON_MAX_*)`)
  lines.push(`  ${C.c}/sim run \"<task>\"${C.B}           LLM controls a persistent Genesis world`)
  lines.push(`  ${C.c}/sim exec|doctor|skills${C.B}     World REPL, env check, skills-as-code`)
  lines.push(`  ${C.c}/voice [--file=x.mp3]${C.B}       Speech-to-text via OpenAI-compatible STT`)
  lines.push(`  ${C.c}/optim scan|init|run${C.B}       Code-aware semantics → reasoning proposals`)
  lines.push("")
  lines.push(`${C.b}EXAMPLES:${C.B}`)
  lines.push(`  ${C.g}momo "Refactor auth to use Effect"${C.B}`)
  lines.push(`  ${C.g}momo /evolve --mode=explore${C.B}`)
  lines.push(`  ${C.g}momo /fine-tune run --auto${C.B}`)
  lines.push(`  ${C.g}momo models list${C.B}`)
  lines.push("")
  lines.push(`${C.b}ENVIRONMENT:${C.B}`)
  lines.push(`  ${C.y}MOMO_API_KEY${C.B}                 Generic API key for any provider`)
  lines.push(`  ${C.y}MOMO_<PROVIDER>_API_KEY${C.B}        Provider-specific API key (e.g. MOMO_ANTHROPIC_API_KEY)`)
  lines.push(`  ${C.y}MOMO_PROVIDER${C.B}                Default provider (anthropic, openai, ...)`)
  lines.push(`  ${C.y}MOMO_MODEL${C.B}                   Default model or tier (ultra/standard/lite)`)
  lines.push(`  ${C.y}MOMO_HOME${C.B}                    momo home directory (default: ~/.momo)`)
  lines.push(`  ${C.y}MOMO_CONFIG${C.B}                  Path to config file`)
  lines.push(`  ${C.y}MOMO_XP_MODE${C.B}                 Evolution mode: balanced|explore|harden|convention-only`)
  lines.push(`  ${C.y}MOMO_SESSION_RECORD${C.B}          Set 'false' to disable trajectory recording`)
  lines.push(`  ${C.y}MOMO_RLM_MAX_DEPTH${C.B}           Subagent recursion limit (default: 3)`)
  lines.push(`  ${C.y}MOMO_RLM_BUDGET${C.B}              Max subagents per orchestration (default: 8)`)
  lines.push(`  ${C.y}MOMO_DAEMON_INTERVAL${C.B}         Daemon poll seconds (default: 60)`)
  lines.push(`  ${C.y}MOMO_STT_API_KEY${C.B}             Voice input STT key (OpenAI-compatible)`)
  lines.push(`  ${C.y}MOMO_STT_MODEL${C.B}               STT model (default: whisper-1)`)
  lines.push("")
  lines.push(`${C.b}QUICK START:${C.B}`)
  lines.push(`  1. Set your API key: ${C.g}export MOMO_API_KEY=sk-...${C.B}`)
  lines.push(`  2. Run:               ${C.g}momo "your coding task"${C.B}`)
  lines.push("")
  lines.push(`${DIM}Docs: https://momozi.cc${RESET}`)
  lines.push("")

  return lines.join("\n")
}

/**
 * Print the full CLI help message to stdout.
 */
export function printHelp(): void {
  console.log(renderHelp())
}
