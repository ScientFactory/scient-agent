# Scient Agent: maintainer guide

Scient Agent is the native research agent of [Scient](https://github.com/ScientFactory/scient-desktop). It is built from [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP): it inherits OMP's agent runtime whole and changes what makes it a separate product. A machine can run Scient Agent and a stock `omp` side by side without either reading, changing, or updating the other.

`scient.json` records the product version and the exact upstream release this tree derives from.

## What Scient changes

Everything else is upstream's code and behavior.

| Area | Change |
|---|---|
| Name | The executable is `scient-agent`, and shell profile aliases run it. `--version` prints `scient-agent/<version>`; `--runtime-info` prints a JSON description (product, version, upstream release and commit, RPC versions, build id) for hosts. Process titles, log files and Windows named pipes carry the name. |
| State | The config root is `~/.scient-agent` (project folder `.scient-agent/`), or the absolute directory a host sets in `SCIENT_AGENT_ROOT`. User config lookups, the native addon cache, browser storage state and crash logs follow it. A host's root is authoritative: `SCIENT_AGENT_DIR` is ignored under it, and a `.env` in the project or the home directory cannot set any `SCIENT_AGENT_*` variable (a `.env` inside the root can). The root is taken only from the launch environment, never from a `.env`. Standalone use keeps upstream's `.env` overrides. |
| Variables | The variables that choose where state lives have `SCIENT_AGENT_*` names: `CONFIG_DIR`, `CONFIG_FILES`, `DIR`, `PROFILE`, `SESSION_DIR`, `WORKTREE_DIR`, `AUTH_BROKER_*`, the cache database overrides, and the runtime directory, socket and configuration variables the agent hands its own workers. OMP's names for them are ignored. Tuning variables (`PI_*`) are unchanged. |
| Native addon cache | A compiled binary extracts its addon into a directory named for the addon's content, so two builds on one upstream version never load each other's, and it loads only that addon: an addon found beside the executable is not a fallback. |
| Updates | `scient-agent update` only updates plugins. The startup update check and the startup marketplace refresh are off. A host or installer replaces the executable. |
| Reporting | Automatic tool-issue reports to OMP's service are off by default. |
| Browser relay | The relay listens on port 9324 (OMP uses 9224), so each product runs its own. |
| Sign-ins | Over RPC, `set_model` re-reads the sign-in store before it reports a model as missing, so a session that was already running finds a sign-in completed in another process. It re-reads the store and runs the sign-in hooks again (`ModelRegistry.reapplySignInProjections`), and rediscovers that provider's models only when the session holds no discovered catalog for it. No static reload runs, so nothing that was usable is lost. A model that only a second account of an already discovered provider has is still reported missing until the session restarts. |

Left as upstream, on purpose:

- Internal package names (`@oh-my-pi/*`) and package versions. The native addon is stamped with and checked against the package version.
- The `omp://` internal URL scheme, the `.omp-plugin` marketplace format, the `${OMP_PLUGIN_ROOT}` substitution and the `omp` key in a plugin's `package.json`: these are formats plugins are written against.
- Which configuration is discovered. Another agent's folder in the home directory (`~/.claude`, `~/.codex`, ...) is read only when `enabledProviders` names it; the same folders in a project are read, as upstream does. Scient Agent does not read `.omp` anywhere.
- Model discovery. On startup the agent refreshes the model catalog from `catalog.stencil.so` (cached, conditional, falls back to the bundled list) and asks several model providers for their public model lists.
- `share`, `collab`, `stream` and the skill registry still default to OMP's services. They run only on an explicit command.
- Provider sign-in routes and their request headers.
- Native sign-in helper state stays under `~/.scient-agent/oauth` even when a host assigns a root. A URL-scheme handler is registered once per user, and that folder holds the lease that keeps two agent processes from registering it at once. OMP uses the same URL schemes with its own lease, so on macOS and Linux Scient Agent refuses to start a sign-in while an OMP sign-in helper holds the scheme, and checks again just before it registers its own. The two products cannot fully exclude each other: a stock `omp` does not know Scient Agent's helper, so starting the same vendor's sign-in in both at once can make one of the two attempts fail. Windows has no such check yet.
- Terminal UI labels and command hints that still say `omp`. Scient drives the agent over RPC.

## Branches and upstream intake

- `upstream` is a fetch-only remote. Scient work lives on one branch per upstream release, named `scient/<upstream version>`: the upstream tag plus Scient's commits. Published branches and tags are never rewritten.
- Scient's commits are ordered. The first adds `scripts/scient/rename-identity.ts`; the second is that script's output and nothing else; the rest are hand-written.

To move to a newer upstream release:

```sh
git fetch --no-tags upstream "refs/tags/v<new>:refs/upstream-tags/v<new>"
git switch -c scient/<new> refs/upstream-tags/v<new>
git cherry-pick <the rename-script commit>
bun install --frozen-lockfile
bun scripts/scient/rename-identity.ts      # regenerates the generated commit; commit the result
git cherry-pick <each hand-written commit, in order>
```

Then update `scient.json`, and run the checks below. Do not cherry-pick the generated commit: regenerate it.

## Build

Needs Bun 1.4 or newer, `rustup` (the toolchain in `rust-toolchain.toml` installs itself), CMake and Ninja.

```sh
bun install --frozen-lockfile
bun run build:native                          # Rust addon for this machine
bun --cwd=packages/coding-agent run build     # packages/coding-agent/dist/scient-agent
```

## Checks

```sh
bun scripts/scient/rename-identity.ts --check   # no OMP state name is left in the source
bun run check:ts
bun --cwd=packages/utils test
bun --cwd=packages/natives test
bun scripts/scient/isolation-check.ts packages/coding-agent/dist/scient-agent
```

`isolation-check.ts` starts the built binary in empty home directories, with every OMP state variable pointing at a decoy and a proxy recording what it tries to reach. It fails if the agent writes its own state outside its config root, follows one of OMP's variables, touches an OMP home, hands its shell a variable that would steer a stock `omp`, or contacts an OMP service or update source unasked. It prints the hosts contacted. It does not limit what a task may write or reach.

It runs without a model, so it covers startup, the RPC handshake and the agent's shell. Scient Desktop's live suites (`OMP_QUALIFY_TARGET=scient`) cover model turns, subagents, background work and sessions against the same executable.

The rest of upstream's test suite still contains tests that assert OMP's names; they are not part of Scient's checks yet.

## Release

`.github/workflows/scient.yml` builds and checks macOS Apple silicon on every push to a `scient/**` branch. Pushing a `v<version>` tag that matches `scient.json` also signs, notarizes and drafts a GitHub release with the binary and its SHA-256. A person publishes the draft. Other platforms are not built yet.
