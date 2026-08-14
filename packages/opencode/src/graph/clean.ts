/**
 * Graph Engine — output/error scrubbing.
 *
 * Subagent stdout is the final answer, but legacy runs and stray child
 * processes can still mix in ANSI colours, Effect/console log lines, and
 * Node warnings. These helpers normalise node output/error so the DAG,
 * dependency context, and synthesis stay readable and token-cheap.
 *
 * @module graph/clean
 */

/** ANSI CSI / OSC escape sequences (colours, cursor moves, hyperlinks). */
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

/** Lines that are internal diagnostics, never part of a node answer. */
const NOISE_LINE = /^(timestamp=\S+\s+level=\w+|\(node:\d+\)|\(Use `node --trace-warnings|\[subagent timed out\]|\[spawn error:|→\s+\S+\s+\|\s+\S+)/

/** Strip ANSI escape sequences from a string. */
export function stripAnsi(text: string): string {
  return String(text ?? "").replace(ANSI_RE, "")
}

/**
 * Normalise a subagent's raw output into a readable node result:
 * ANSI codes removed, internal log lines dropped, blank runs collapsed.
 */
export function cleanNodeOutput(text: string): string {
  const lines = stripAnsi(text ?? "").split(/\r?\n/)
  const kept: string[] = []
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim() || NOISE_LINE.test(line.trim())) continue
    kept.push(line)
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** Normalise failure text the same way; empty when there is nothing useful. */
export function cleanNodeError(text: string): string {
  return cleanNodeOutput(text)
}