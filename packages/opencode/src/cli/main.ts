/**
 * Standalone CLI entry point for Bun `--compile` binaries.
 *
 * This module is the runtime entry point when momo is packaged as a single-file
 * executable (`momo-main.exe`, `momo`, etc.). It intercepts `--help`, `-h`,
 * `--version`, and `help` before routing everything else to the normal Node.js
 * command router.
 *
 * Help and version are handled at the top of the file and `runCli` is loaded
 * lazily so that `--help` never triggers provider initialization or API-key
 * checks.
 */
import { renderHelp } from "./help.js"

declare global {
  // Injected by the Bun compile build step.
  const MOMO_VERSION: string | undefined
}

function showHelp(): void {
  console.log(renderHelp())
}

function showVersion(): void {
  // `MOMO_VERSION` is injected by the build script for compiled binaries.
  const version = typeof MOMO_VERSION !== "undefined" ? MOMO_VERSION : "0.1.0"
  console.log(version)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0])) {
    showHelp()
    return
  }

  if (["version", "--version", "-v"].includes(argv[0])) {
    showVersion()
    return
  }

  // Lazy-load the command router so that `--help` never pulls in provider
  // configuration or chat modules.
  const { runCli } = await import("./index.js")
  await runCli(argv)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
