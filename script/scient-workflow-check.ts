#!/usr/bin/env bun

import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const OWNED_WORKFLOWS = new Set([
  ".github/workflows/scient-quality.yml",
  ".github/workflows/scient-release.yml",
  ".github/workflows/scient-upstream-monitor.yml",
])
const UPSTREAM_REPOSITORY_GUARD =
  /^github\.repository\s*==\s*['"](?:anomalyco\/opencode|sst\/opencode)['"](?:\s*&&|\s*$)/
const IMMUTABLE_ACTION_REF = /@[0-9a-f]{40}$/
const IMMUTABLE_CONTAINER_REF = /^docker:\/\/.+@sha256:[0-9a-f]{64}$/i

export interface WorkflowFile {
  readonly path: string
  readonly contents: string
}

export interface WorkflowSafetyViolation {
  readonly path: string
  readonly message: string
}

interface ActionUse {
  readonly reference: string
  readonly localRoot: ".github/actions" | ".github/workflows"
}

export function findWorkflowSafetyViolations(files: readonly WorkflowFile[]) {
  const violations: WorkflowSafetyViolation[] = []
  for (const file of files) {
    let document: unknown
    try {
      document = Bun.YAML.parse(file.contents)
    } catch (error) {
      violations.push({ path: file.path, message: `YAML is invalid: ${String(error)}` })
      continue
    }

    for (const { reference: use, localRoot } of actionUses(document)) {
      if (use.startsWith("./")) {
        if (isScannedLocalReference(use, localRoot)) continue
        violations.push({
          path: file.path,
          message: `local reference must live under the recursively scanned ${localRoot} directory: ${use}`,
        })
        continue
      }
      if (use.toLowerCase().startsWith("docker://")) {
        if (IMMUTABLE_CONTAINER_REF.test(use)) continue
        violations.push({ path: file.path, message: `container action is not pinned to a sha256 digest: ${use}` })
        continue
      }
      if (IMMUTABLE_ACTION_REF.test(use)) continue
      violations.push({ path: file.path, message: `external action is not pinned to a full commit SHA: ${use}` })
    }

    if (!file.path.startsWith(".github/workflows/") || OWNED_WORKFLOWS.has(file.path)) continue
    if (!isRecord(document) || !isRecord(document.jobs)) {
      violations.push({ path: file.path, message: "inherited workflow must define a jobs mapping" })
      continue
    }
    for (const [jobName, job] of Object.entries(document.jobs)) {
      if (!isRecord(job)) {
        violations.push({ path: file.path, message: `job ${jobName} must be a mapping` })
        continue
      }
      const condition = job.if
      if (condition === false) continue
      if (typeof condition === "string" && hasSafeUpstreamGuard(condition)) continue
      violations.push({
        path: file.path,
        message: `inherited job ${jobName} must be disabled or guarded to an upstream repository`,
      })
    }
  }
  return violations
}

function isScannedLocalReference(use: string, localRoot: ActionUse["localRoot"]) {
  const prefix = `./${localRoot}/`
  if (!use.startsWith(prefix)) return false
  const segments = use.slice(prefix.length).split("/")
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
}

function actionUses(document: unknown): ActionUse[] {
  if (!isRecord(document)) return []
  const result: ActionUse[] = []
  if (isRecord(document.jobs)) {
    for (const job of Object.values(document.jobs)) {
      if (!isRecord(job)) continue
      if (typeof job.uses === "string") {
        result.push({ reference: job.uses, localRoot: ".github/workflows" })
      }
      result.push(...stepUses(job.steps))
    }
  }
  if (isRecord(document.runs)) {
    result.push(...stepUses(document.runs.steps))
    if (
      typeof document.runs.using === "string" &&
      document.runs.using.toLowerCase() === "docker" &&
      typeof document.runs.image === "string" &&
      document.runs.image.toLowerCase().startsWith("docker://")
    ) {
      result.push({ reference: document.runs.image, localRoot: ".github/actions" })
    }
  }
  return result
}

function stepUses(steps: unknown): ActionUse[] {
  if (!Array.isArray(steps)) return []
  return steps.flatMap((step) =>
    isRecord(step) && typeof step.uses === "string"
      ? [{ reference: step.uses, localRoot: ".github/actions" as const }]
      : [],
  )
}

function hasSafeUpstreamGuard(condition: string) {
  const trimmed = condition.trim()
  const guard = UPSTREAM_REPOSITORY_GUARD.exec(trimmed)
  if (!guard) return false
  if (!guard[0].trimEnd().endsWith("&&")) return guard[0].length === trimmed.length
  return !hasTopLevelOr(trimmed.slice(guard[0].length))
}

function hasTopLevelOr(expression: string) {
  let depth = 0
  let quote: "'" | '"' | null = null
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index]
    if (quote) {
      if (character === "\\") index++
      else if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === "(") depth++
    else if (character === ")") {
      depth--
      if (depth < 0) return true
    } else if (character === "|" && expression[index + 1] === "|" && depth === 0) return true
  }
  return depth !== 0 || quote !== null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function yamlFiles(root: string): WorkflowFile[] {
  const result: WorkflowFile[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in scanned workflow trees: ${absolute}`)
    if (entry.isDirectory()) {
      result.push(...yamlFiles(absolute))
      continue
    }
    if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue
    result.push({ path: absolute.replaceAll(path.sep, "/"), contents: readFileSync(absolute, "utf8") })
  }
  return result
}

function main() {
  const files = [...yamlFiles(".github/workflows"), ...yamlFiles(".github/actions")]
  const violations = findWorkflowSafetyViolations(files)
  if (!violations.length) {
    console.log("Scient workflow isolation and immutable-action check passed.")
    return
  }
  for (const violation of violations) console.error(`${violation.path}: ${violation.message}`)
  process.exitCode = 1
}

if (import.meta.main) main()
