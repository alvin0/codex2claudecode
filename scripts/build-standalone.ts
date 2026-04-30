/**
 * Build standalone executables using `bun build --compile`.
 *
 * The resulting binary embeds the Bun runtime, all dependencies, and the
 * application code into a single file that runs without any external runtime
 * (no Bun, Node, npx, or bunx required on the target machine).
 *
 * Usage:
 *   bun run build:compile              # build for current platform
 *   bun run build:compile:all          # build for all supported platforms
 *   bun run scripts/build-standalone.ts --target=bun-linux-x64
 */

import { parseArgs } from "util"
import { mkdirSync } from "fs"

const APP_NAME = "codex2claudecode"
const ENTRY = "index.ts"
const OUT_DIR = "dist/standalone"

interface Target {
  /** Bun cross-compile target identifier */
  bun: string
  /** Human-readable label */
  label: string
  /** Output file suffix (including extension for Windows) */
  suffix: string
}

const TARGETS: Target[] = [
  { bun: "bun-darwin-arm64", label: "macOS Apple Silicon", suffix: "-darwin-arm64" },
  { bun: "bun-darwin-x64", label: "macOS Intel", suffix: "-darwin-x64" },
  { bun: "bun-linux-x64", label: "Linux x64", suffix: "-linux-x64" },
  { bun: "bun-linux-arm64", label: "Linux ARM64", suffix: "-linux-arm64" },
  { bun: "bun-windows-x64", label: "Windows x64", suffix: "-windows-x64.exe" },
]

function currentPlatformTarget(): Target {
  const arch = process.arch === "arm64" ? "arm64" : "x64"
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux"
  const id = `bun-${os}-${arch}`
  return TARGETS.find((t) => t.bun === id) ?? { bun: id, label: `${os} ${arch}`, suffix: `-${os}-${arch}` }
}

async function buildTarget(target: Target) {
  const outFile = `${OUT_DIR}/${APP_NAME}${target.suffix}`
  console.log(`\n  Building ${target.label} (${target.bun}) → ${outFile}`)

  const proc = Bun.spawn({
    cmd: [
      "bun",
      "build",
      ENTRY,
      "--compile",
      `--target=${target.bun}`,
      `--outfile=${outFile}`,
    ],
    stdout: "pipe",
    stderr: "pipe",
  })

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  if (exitCode !== 0) {
    console.error(`  ✗ Failed (exit ${exitCode})`)
    if (stderr.trim()) console.error(`    ${stderr.trim().split("\n").join("\n    ")}`)
    if (stdout.trim()) console.error(`    ${stdout.trim().split("\n").join("\n    ")}`)
    return false
  }

  console.log(`  ✓ ${outFile}`)
  return true
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      all: { type: "boolean", default: false },
      target: { type: "string" },
    },
    strict: false,
  })

  mkdirSync(OUT_DIR, { recursive: true })

  let targets: Target[]

  if (values.all) {
    targets = TARGETS
  } else if (values.target) {
    const match = TARGETS.find((t) => t.bun === values.target)
    targets = [match ?? { bun: values.target as string, label: values.target as string, suffix: `-${(values.target as string).replace(/^bun-/, "")}` }]
  } else {
    targets = [currentPlatformTarget()]
  }

  console.log(`Building standalone executables...`)
  console.log(`  Entry:  ${ENTRY}`)
  console.log(`  Output: ${OUT_DIR}/`)

  let failed = 0
  for (const target of targets) {
    const ok = await buildTarget(target)
    if (!ok) failed += 1
  }

  console.log()
  if (failed > 0) {
    console.error(`${failed} of ${targets.length} build(s) failed.`)
    process.exit(1)
  }
  console.log(`All ${targets.length} build(s) succeeded.`)
  console.log()
  console.log("The standalone binary can be distributed and run directly:")
  console.log(`  ./${OUT_DIR}/${APP_NAME}${targets[0].suffix} --port 8787`)
  console.log()
  console.log("No Bun, Node.js, npx, or bunx required on the target machine.")
}

main()
