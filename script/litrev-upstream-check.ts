#!/usr/bin/env bun

import { execFileSync } from "node:child_process"
import path from "node:path"

const EXPECTED_ORIGIN = "git@github.com:yaacovcorcos/opencode.git"
const EXPECTED_UPSTREAM = "https://github.com/anomalyco/opencode.git"
const UPSTREAM_BRANCH = "upstream/dev"

const run = (command: string, args: string[], cwd = process.cwd()) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

const assertEqual = (label: string, actual: string, expected: string) => {
  if (actual === expected) return
  throw new Error(`${label} mismatch: expected ${expected}, received ${actual || "(empty)"}`)
}

const initialStatus = run("git", ["status", "--porcelain"])
if (initialStatus) throw new Error("Run the upstream check from a clean OpenCode worktree.")

assertEqual("origin fetch URL", run("git", ["remote", "get-url", "origin"]), EXPECTED_ORIGIN)
assertEqual("upstream fetch URL", run("git", ["remote", "get-url", "upstream"]), EXPECTED_UPSTREAM)
assertEqual("upstream push URL", run("git", ["remote", "get-url", "--push", "upstream"]), "DISABLED")

if (process.argv.includes("--fetch")) execFileSync("git", ["fetch", "--prune", "upstream"], { stdio: "inherit" })

const checks = process.argv.includes("--checks")
if (checks) {
  const packageDirectory = path.join(process.cwd(), "packages", "opencode")
  execFileSync("bun", ["run", "typecheck"], { cwd: packageDirectory, stdio: "inherit" })
  execFileSync("bun", ["run", "build"], { cwd: packageDirectory, stdio: "inherit" })
  execFileSync("bun", ["run", "dev", "--version"], { cwd: packageDirectory, stdio: "inherit" })
}

if (run("git", ["status", "--porcelain"]) !== initialStatus) {
  throw new Error("Verification changed tracked or untracked source files.")
}

const divergence = run("git", ["rev-list", "--left-right", "--count", `HEAD...${UPSTREAM_BRANCH}`]).split(/\s+/)
console.log(
  JSON.stringify(
    {
      repository: "yaacovcorcos/opencode",
      head: run("git", ["rev-parse", "HEAD"]),
      upstream: run("git", ["rev-parse", UPSTREAM_BRANCH]),
      ahead: divergence[0],
      behind: divergence[1],
      sourceVersion: JSON.parse(await Bun.file(path.join(process.cwd(), "packages/opencode/package.json")).text())
        .version,
      checksRun: checks,
    },
    null,
    2,
  ),
)
