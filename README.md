# Scient Agent Source

This repository is the ScientFactory-owned source foundation for the planned
native Scient research agent. It is maintained as a standalone repository and
is derived from OpenCode under the MIT license.

## Current status

The repository boundary and upstream-maintenance system are active. The native
Scient agent product identity, scientific workflow layer, and release channel
are still planned rather than implemented.

Inherited packages, commands, configuration keys, and protocol identifiers may
therefore still use OpenCode names. Those compatibility identifiers are not the
public Scient product identity, and they should not be renamed broadly without
a bounded migration and verification plan.

This repository is primarily for source maintenance and native-agent
development. For the current Scient application, use
[`ScientFactory/scient-desktop`](https://github.com/ScientFactory/scient-desktop).

## Repository family

- [`ScientFactory/Scient`](https://github.com/ScientFactory/Scient) owns product
  direction, architecture, planning, and the canonical scientific boundary.
- [`ScientFactory/scient-desktop`](https://github.com/ScientFactory/scient-desktop)
  owns the current desktop application.
- [`ScientFactory/scient-agent`](https://github.com/ScientFactory/scient-agent)
  owns this native-agent source foundation.
- [`ScientFactory/ScientFactory-website`](https://github.com/ScientFactory/ScientFactory-website)
  owns the public website and download experience.

Internal contributors may keep these independent repositories as sibling
checkouts in one plain local workspace for shared read context. Cross-repository
changes still require separate branches, worktrees, commits, and pull requests,
with dependencies stated explicitly.

## Development

The default branch is `dev`. Install the pinned Bun toolchain and dependencies,
then use the repository-owned quality commands:

```sh
bun install --frozen-lockfile
bun run scient:identity-check
bun run scient:upstream-check
bun turbo typecheck
```

Tests must be run from the package that owns them. For the inherited agent core:

```sh
cd packages/opencode
bun test
bun run build
```

Read [AGENTS.md](./AGENTS.md) before changing source and
[CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

## Upstream lineage

The source foundation is derived from
[`anomalyco/opencode`](https://github.com/anomalyco/opencode). OpenCode remains a
read-only source of optional improvements; it does not control Scient's product
direction, identity, or release schedule. See [UPSTREAM.md](./UPSTREAM.md) for
the fetch-only remote policy, review checkpoints, and selective-intake process.

The translated OpenCode README files and inherited package documentation remain
in the tree as upstream source material. They are not Scient installation or
support instructions.

## Security and support

- Report vulnerabilities privately through the
  [Scient agent security advisory form](https://github.com/ScientFactory/scient-agent/security/advisories/new).
- Report source-foundation bugs through this repository's issue templates.
- Report current desktop application problems in
  [`ScientFactory/scient-desktop`](https://github.com/ScientFactory/scient-desktop/issues).
