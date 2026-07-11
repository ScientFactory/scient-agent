#!/usr/bin/env bun

import { execFileSync } from "node:child_process"
import path from "node:path"

const EXPECTED_ORIGIN_REPOSITORY = "yaacovcorcos/opencode"
const EXPECTED_UPSTREAM_REPOSITORY = "anomalyco/opencode"
const UPSTREAM_BRANCH = "upstream/dev"

type CommandFailure = Error & {
  stderr?: string | Uint8Array
  stdout?: string | Uint8Array
}

function commandFailureDetails(error: unknown) {
  if (!(error instanceof Error)) return String(error)
  const failure = error as CommandFailure
  return failure.stderr?.toString().trim() || failure.stdout?.toString().trim() || error.message
}

function run(command: string, args: string[], cwd = process.cwd()) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
  } catch (error) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}\n${commandFailureDetails(error)}`, { cause: error })
  }
}

function runVisible(command: string, args: string[], cwd = process.cwd()) {
  try {
    execFileSync(command, args, { cwd, stdio: "inherit" })
  } catch (error) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`, { cause: error })
  }
}

export function githubRepositoryFromRemote(remote: string) {
  const trimmed = remote.trim().replace(/\/+$/, "")
  const scpMatch = /^git@github\.com:([^/]+)\/(.+)$/i.exec(trimmed)
  const urlMatch = /^(?:ssh:\/\/git@|https?:\/\/)github\.com\/([^/]+)\/(.+)$/i.exec(trimmed)
  const match = scpMatch ?? urlMatch
  if (!match?.[1] || !match[2]) return null
  return `${match[1]}/${match[2].replace(/\.git$/i, "")}`.toLowerCase()
}

export function shouldFetchUpstream(args: string[]) {
  return !args.includes("--no-fetch")
}

function assertGitHubRemote(label: string, remote: string, expectedRepository: string) {
  if (githubRepositoryFromRemote(remote) === expectedRepository.toLowerCase()) return
  throw new Error(
    `${label} mismatch: expected GitHub repository ${expectedRepository}, received ${remote || "(empty)"}`,
  )
}

async function main() {
  const initialStatus = run("git", ["status", "--porcelain"])
  if (initialStatus) throw new Error("Run the OpenCode source check from a clean worktree.")

  assertGitHubRemote("origin fetch URL", run("git", ["remote", "get-url", "origin"]), EXPECTED_ORIGIN_REPOSITORY)
  assertGitHubRemote(
    "origin push URL",
    run("git", ["remote", "get-url", "--push", "origin"]),
    EXPECTED_ORIGIN_REPOSITORY,
  )
  assertGitHubRemote("upstream fetch URL", run("git", ["remote", "get-url", "upstream"]), EXPECTED_UPSTREAM_REPOSITORY)
  const upstreamPushUrl = run("git", ["remote", "get-url", "--push", "upstream"])
  if (upstreamPushUrl !== "DISABLED") {
    throw new Error(`upstream push URL mismatch: expected DISABLED, received ${upstreamPushUrl || "(empty)"}`)
  }

  const fetched = shouldFetchUpstream(process.argv.slice(2))
  if (fetched) runVisible("git", ["fetch", "--prune", "upstream"])
  run("git", ["rev-parse", "--verify", UPSTREAM_BRANCH])

  const sourceChecks = process.argv.includes("--checks")
  if (sourceChecks) {
    const packageDirectory = path.join(process.cwd(), "packages", "opencode")
    runVisible("bun", ["run", "typecheck"], packageDirectory)
    // These inherited integration files are resource-sensitive: the PTY file
    // stalls after earlier files on macOS, while the subprocess file can starve
    // its own 15-second regression oracle on a two-core CI runner. Run every test
    // while giving both files controlled fresh processes; no coverage is skipped.
    runVisible(
      "bun",
      [
        "test",
        "--timeout",
        "60000",
        "--only-failures",
        "--path-ignore-patterns",
        "test/server/httpapi-v2-pty.test.ts",
        "--path-ignore-patterns",
        "test/cli/run/run-process.test.ts",
      ],
      packageDirectory,
    )
    runVisible(
      "bun",
      ["test", "--timeout", "60000", "--only-failures", "test/server/httpapi-v2-pty.test.ts"],
      packageDirectory,
    )
    runVisible(
      "bun",
      ["test", "--timeout", "60000", "--only-failures", "--max-concurrency", "2", "test/cli/run/run-process.test.ts"],
      packageDirectory,
    )
    runVisible("bun", ["run", "build"], packageDirectory)
    runVisible("bun", ["run", "dev", "--version"], packageDirectory)
  }

  if (run("git", ["status", "--porcelain"]) !== initialStatus) {
    throw new Error("Verification changed tracked or untracked source files.")
  }

  const divergence = run("git", ["rev-list", "--left-right", "--count", `HEAD...${UPSTREAM_BRANCH}`]).split(/\s+/)
  console.log(
    JSON.stringify(
      {
        repository: EXPECTED_ORIGIN_REPOSITORY,
        head: run("git", ["rev-parse", "HEAD"]),
        upstream: run("git", ["rev-parse", UPSTREAM_BRANCH]),
        ahead: divergence[0],
        behind: divergence[1],
        upstreamFetched: fetched,
        sourceVersion: JSON.parse(await Bun.file(path.join(process.cwd(), "packages/opencode/package.json")).text())
          .version,
        deterministicSourceChecksRun: sourceChecks,
        crossRepositorySynaraSmokeRun: false,
      },
      null,
      2,
    ),
  )
}

if (import.meta.main) await main()
