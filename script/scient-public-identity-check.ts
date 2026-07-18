const requiredText = new Map<string, readonly string[]>([
  [
    "README.md",
    ["# Scient Agent Source", "ScientFactory/scient-agent", "native Scient research agent", "anomalyco/opencode"],
  ],
  ["CONTRIBUTING.md", ["# Contributing to Scient Agent Source", "ScientFactory/scient-desktop"]],
  ["SECURITY.md", ["# Security policy", "https://github.com/ScientFactory/scient-agent/security/advisories/new"]],
  [".github/CODEOWNERS", ["* @yaacovcorcos"]],
  [".github/TEAM_MEMBERS", ["yaacovcorcos"]],
  [".github/ISSUE_TEMPLATE/bug-report.yml", ["Scient agent source revision"]],
  [".github/ISSUE_TEMPLATE/feature-request.yml", ["Native Scient agent capability"]],
  [".github/ISSUE_TEMPLATE/config.yml", ["https://github.com/ScientFactory/scient-desktop/issues"]],
  [".github/pull_request_template.md", ["### Boundaries", "inherited OpenCode lineage"]],
])

const publicSurfacePaths = [...requiredText.keys(), "package.json"]
const forbiddenPublicText = [
  "https://opencode.ai",
  "https://discord.gg/opencode",
  "github.com/anomalyco/opencode/actions",
  "github.com/anomalyco/opencode/releases",
  "github.com/anomalyco/opencode/issues",
  "github.com/anomalyco/opencode/security/advisories",
  "security@anoma.ly",
  "# Contributing to OpenCode",
  "OpenCode version",
] as const

export interface PublicIdentityFile {
  path: string
  contents: string
}

export interface PublicIdentityViolation {
  path: string
  message: string
}

export function findPublicIdentityViolations(files: readonly PublicIdentityFile[]) {
  const byPath = new Map(files.map((file) => [file.path, file.contents]))
  const missing = [...requiredText].flatMap(([path, values]) => {
    const contents = byPath.get(path)
    if (contents === undefined) return [{ path, message: "required public identity file is missing" }]
    return values
      .filter((value) => !contents.includes(value))
      .map((value) => ({ path, message: `missing required text: ${value}` }))
  })
  const forbidden = files.flatMap((file) =>
    forbiddenPublicText
      .filter((value) => file.contents.includes(value))
      .map((value) => ({ path: file.path, message: `forbidden upstream public link or copy: ${value}` })),
  )
  const packageJson = byPath.get("package.json")
  const repository = packageJson ? JSON.parse(packageJson).repository?.url : undefined
  const metadata =
    repository === "https://github.com/ScientFactory/scient-agent"
      ? []
      : [{ path: "package.json", message: "root repository URL must point to ScientFactory/scient-agent" }]
  return [...missing, ...forbidden, ...metadata]
}

async function main() {
  const files = await Promise.all(
    publicSurfacePaths.map(async (path) => ({ path, contents: await Bun.file(path).text() })),
  )
  const violations = findPublicIdentityViolations(files)
  if (!violations.length) {
    console.log("Scient agent public identity check passed.")
    return
  }
  for (const violation of violations) console.error(`${violation.path}: ${violation.message}`)
  process.exitCode = 1
}

if (import.meta.main) await main()
