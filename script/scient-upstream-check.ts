#!/usr/bin/env bun

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

const EXPECTED_ORIGIN_REPOSITORY = "ScientFactory/scient-agent"
const EXPECTED_ORIGIN_BRANCH = "dev"
const EXPECTED_UPSTREAM_REPOSITORY = "anomalyco/opencode"
const EXPECTED_UPSTREAM_BRANCH = "dev"
const UPSTREAM_BRANCH = `upstream/${EXPECTED_UPSTREAM_BRANCH}`
const UPSTREAM_STATE_PATH = "upstream-state.json"

const UPDATE_MODES = new Set([
  "no-upstream",
  "version-bump",
  "adapter-maintained",
  "thin-fork-merge",
  "divergent-cherry-pick",
  "reference-only",
  "deferred",
])

export type UpstreamState = {
  schemaVersion: 1
  ownedRepository: string
  ownedDefaultBranch: string
  officialRepository: string
  officialDefaultBranch: string
  updateMode: string
  reviewedThrough: string
  reviewedAt: string
  integrationBase: string
  reviewRecord: string
}

export type VerificationMode = "report" | "review" | "intake"

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

export function resolveVerificationMode(args: string[]): VerificationMode {
  const review = args.includes("--review-check")
  const intake = args.includes("--intake") || args.includes("--checks")
  if (review && intake) throw new Error("Choose either --review-check or --intake, not both.")
  if (intake) return "intake"
  if (review) return "review"
  return "report"
}

export function parseUpstreamState(value: unknown): UpstreamState {
  if (!isRecord(value)) {
    throw new Error(`${UPSTREAM_STATE_PATH} must contain a JSON object.`)
  }
  if (value.schemaVersion !== 1) throw new Error(`${UPSTREAM_STATE_PATH} schemaVersion must be 1.`)
  const state = {
    schemaVersion: 1 as const,
    ownedRepository: requireString(value, "ownedRepository"),
    ownedDefaultBranch: requireString(value, "ownedDefaultBranch"),
    officialRepository: requireString(value, "officialRepository"),
    officialDefaultBranch: requireString(value, "officialDefaultBranch"),
    updateMode: requireString(value, "updateMode"),
    reviewedThrough: requireString(value, "reviewedThrough"),
    reviewedAt: requireString(value, "reviewedAt"),
    integrationBase: requireString(value, "integrationBase"),
    reviewRecord: requireString(value, "reviewRecord"),
  }
  if (!UPDATE_MODES.has(state.updateMode)) {
    throw new Error(`${UPSTREAM_STATE_PATH} has unsupported updateMode ${state.updateMode}.`)
  }
  for (const [key, commit] of [
    ["reviewedThrough", state.reviewedThrough],
    ["integrationBase", state.integrationBase],
  ] as const) {
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      throw new Error(`${UPSTREAM_STATE_PATH} field ${key} must be a full lowercase commit SHA.`)
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(state.reviewedAt)) {
    throw new Error(`${UPSTREAM_STATE_PATH} field reviewedAt must use YYYY-MM-DD.`)
  }
  return state
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireString(value: Record<string, unknown>, key: string) {
  const field = value[key]
  if (typeof field === "string" && field) return field
  throw new Error(`${UPSTREAM_STATE_PATH} field ${key} must be a non-empty string.`)
}

function assertGitHubRemote(label: string, remote: string, expectedRepository: string) {
  if (githubRepositoryFromRemote(remote) === expectedRepository.toLowerCase()) return
  throw new Error(
    `${label} mismatch: expected GitHub repository ${expectedRepository}, received ${remote || "(empty)"}`,
  )
}

function assertStateIdentity(state: UpstreamState) {
  if (state.ownedRepository !== EXPECTED_ORIGIN_REPOSITORY) {
    throw new Error(`${UPSTREAM_STATE_PATH} field ownedRepository must be ${EXPECTED_ORIGIN_REPOSITORY}.`)
  }
  if (state.ownedDefaultBranch !== EXPECTED_ORIGIN_BRANCH) {
    throw new Error(`${UPSTREAM_STATE_PATH} field ownedDefaultBranch must be ${EXPECTED_ORIGIN_BRANCH}.`)
  }
  if (state.officialRepository !== EXPECTED_UPSTREAM_REPOSITORY) {
    throw new Error(`${UPSTREAM_STATE_PATH} field officialRepository must be ${EXPECTED_UPSTREAM_REPOSITORY}.`)
  }
  if (state.officialDefaultBranch !== EXPECTED_UPSTREAM_BRANCH) {
    throw new Error(`${UPSTREAM_STATE_PATH} field officialDefaultBranch must be ${EXPECTED_UPSTREAM_BRANCH}.`)
  }
}

function assertAncestor(ancestor: string, descendant: string, label: string) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { stdio: "ignore" })
  } catch (error) {
    throw new Error(`${label}: ${ancestor} is not an ancestor of ${descendant}.`, { cause: error })
  }
}

async function main() {
  const args = process.argv.slice(2)
  const mode = resolveVerificationMode(args)
  const initialStatus = run("git", ["status", "--porcelain"])
  if (mode === "intake" && initialStatus) {
    throw new Error("Run Scient agent intake verification from a clean worktree.")
  }

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

  const fetched = shouldFetchUpstream(args)
  if (fetched) runVisible("git", ["fetch", "--prune", "upstream"])
  const upstreamTip = run("git", ["rev-parse", "--verify", UPSTREAM_BRANCH])
  const state = parseUpstreamState(JSON.parse(readFileSync(path.join(process.cwd(), UPSTREAM_STATE_PATH), "utf8")))
  assertStateIdentity(state)
  run("git", ["cat-file", "-e", `${state.reviewedThrough}^{commit}`])
  run("git", ["cat-file", "-e", `${state.integrationBase}^{commit}`])
  assertAncestor(state.reviewedThrough, upstreamTip, "Invalid upstream review checkpoint")
  assertAncestor(state.integrationBase, upstreamTip, "Integration base is not official upstream history")
  assertAncestor(state.integrationBase, "HEAD", "Integration base is not present in owned history")

  const divergence = run("git", ["rev-list", "--left-right", "--count", `HEAD...${UPSTREAM_BRANCH}`]).split(/\s+/)
  const unreviewedCommits = Number(
    run("git", ["rev-list", "--count", `${state.reviewedThrough}..${upstreamTip}`]),
  )

  if (mode === "intake") {
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

  console.log(
    JSON.stringify(
      {
        repository: EXPECTED_ORIGIN_REPOSITORY,
        head: run("git", ["rev-parse", "HEAD"]),
        upstream: upstreamTip,
        ahead: divergence[0],
        behind: divergence[1],
        upstreamFetched: fetched,
        verificationMode: mode,
        worktreeClean: !initialStatus,
        review: {
          reviewedThrough: state.reviewedThrough,
          reviewedAt: state.reviewedAt,
          reviewRecord: state.reviewRecord,
          current: unreviewedCommits === 0,
          unreviewedCommits,
        },
        integrationBase: state.integrationBase,
        updateMode: state.updateMode,
        sourceVersion: JSON.parse(
          readFileSync(path.join(process.cwd(), "packages/opencode/package.json"), "utf8"),
        ).version,
        deterministicSourceChecksRun: mode === "intake",
        crossRepositoryScientDesktopSmokeRun: false,
      },
      null,
      2,
    ),
  )
}

if (import.meta.main) await main()
