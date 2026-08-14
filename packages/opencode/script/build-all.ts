#!/usr/bin/env bun
/**
 * Cross-platform build script for momo.exe
 * Builds standalone executables for all supported platforms
 */

const targets = [
  { target: "bun-windows-x64", ext: ".exe", name: "momo-windows-x64.exe" },
  { target: "bun-windows-arm64", ext: ".exe", name: "momo-windows-arm64.exe" },
  { target: "bun-darwin-x64", ext: "", name: "momo-macos-x64" },
  { target: "bun-darwin-arm64", ext: "", name: "momo-macos-arm64" },
  { target: "bun-linux-x64", ext: "", name: "momo-linux-x64" },
  { target: "bun-linux-arm64", ext: "", name: "momo-linux-arm64" },
]

const entrypoint = "./src/main.ts"
const outdir = "./dist"

console.log("Building momo for all platforms...\n")

for (const { target, name } of targets) {
  console.log(`Building ${target}...`)
  const proc = Bun.spawnSync([
    "bun", "build", "--compile",
    `--target=${target}`,
    `--outfile=${outdir}/${name}`,
    entrypoint,
  ])

  if (proc.exitCode !== 0) {
    console.error(`  Failed: ${proc.stderr.toString()}`)
  } else {
    console.log(`  ✓ ${name}`)
  }
}

console.log("\nDone! Executables in ./dist/")
