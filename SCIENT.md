# Scient Agent: maintainer guide

Scient Agent is the native research agent of [Scient](https://github.com/ScientFactory/scient-desktop). It is built from [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP): it inherits OMP's agent runtime whole and changes what makes it a separate product. A machine can run Scient Agent and a stock `omp` side by side without either reading, changing, or updating the other.

`scient.json` records the product version and the exact upstream release this tree derives from.

## What Scient changes

Everything else is upstream's code and behavior.

| Area | Change |
|---|---|
| Name | The executable is `scient-agent`, and shell profile aliases run it. `--version` prints `scient-agent/<version>`; `--runtime-info` prints a JSON description (product, version, upstream release and commit, RPC versions, build id) for hosts. Process titles, log files and Windows named pipes carry the name. |
| Wording | The agent calls itself Scient Agent, and its command `scient-agent`, wherever a person or a model reads its words: messages, help, sign-in instructions, prompts, the built-in documentation, window and notification titles. `scripts/scient/rename-wording.ts` generates this. |
| State | The config root is `~/.scient-agent` (project folder `.scient-agent/`), or the absolute directory a host sets in `SCIENT_AGENT_ROOT`. User config lookups, the native addon cache, browser storage state and crash logs follow it. A host's root is authoritative: `SCIENT_AGENT_DIR` is ignored under it, and a `.env` in the project or the home directory cannot set any `SCIENT_AGENT_*` variable (a `.env` inside the root can). The root is taken only from the launch environment, never from a `.env`. Standalone use keeps upstream's `.env` overrides. |
| Variables | The variables that choose where state lives have `SCIENT_AGENT_*` names: `CONFIG_DIR`, `CONFIG_FILES`, `DIR`, `PROFILE`, `SESSION_DIR`, `WORKTREE_DIR`, `AUTH_BROKER_*`, `NATIVES_DIR`, the cache database overrides, and the runtime directory, socket and configuration variables the agent hands its own workers. OMP's names for them are ignored. Tuning variables (`PI_*`) are unchanged. |
| Native addon cache | A compiled binary extracts its addon into a directory named for the addon's content, so two builds on one upstream version never load each other's, and it loads only that addon: an addon found beside the executable is not a fallback. |
| Symbol | The sign-in page every browser sign-in ends on and the `stats` dashboard show Scient Agent's symbol (`packages/utils/src/brand/scient-agent-symbol.svg`, the file Scient Desktop shows for the agent; copy it over when the symbol changes) in Scient's colors. |
| Tiny model worker | Its launch tag carries the product version, not the upstream package version, so a new Scient Agent release replaces a worker an earlier release left running. |
| Updates | `scient-agent update` only updates plugins. The startup update check and the startup marketplace refresh are off. A host or installer replaces the executable. |
| Reporting | Automatic tool-issue reports to OMP's service are off by default. |
| Browser relay | The relay listens on port 9324 (OMP uses 9224), so each product runs its own. |
| Sign-ins | Over RPC the agent starts without a model (a host signs in and picks one afterwards; a model named with `--model` that cannot be resolved still ends the run). `get_login_providers` also reports each entry's `kind` (`account` or `key`) whether a sign-in is `stored`, and the `store` it is kept under: two entries with one `store` are two ways to sign in to one account and share status and sign-out. `logout` without `credentialId` removes an entry's stored sign-ins and fails when the store still holds them afterwards; with an integer `credentialId`, it retains upstream's per-account removal and reports remaining authentication. When the active credential store is an auth broker's snapshot (`credentials.heldByBroker`), the broker owns the sign-ins: they are listed as not stored and `logout` is refused. `set_model` re-reads the sign-in store before it reports a model as missing, so a session that was already running finds a sign-in completed in another process. It revalidates the active local or broker-backed store and runs the sign-in hooks again (`ModelRegistry.reapplySignInProjections`), and rediscovers that provider's models only when the session holds no discovered catalog for it. No static reload runs, so nothing that was usable is lost. A model that only a second account of an already discovered provider has is still reported missing until the session restarts. |

Left as upstream, on purpose:

- Internal package names (`@oh-my-pi/*`) and package versions. The native addon is stamped with and checked against the package version.
- The `omp://` internal URL scheme, the `.omp-plugin` marketplace format, the `${OMP_PLUGIN_ROOT}` substitution and the `omp` key in a plugin's `package.json`: these are formats plugins are written against.
- Which configuration is discovered. Another agent's folder in the home directory (`~/.claude`, `~/.codex`, ...) is read only when `enabledProviders` names it; the same folders in a project are read, as upstream does. Scient Agent does not read `.omp` anywhere.
- Model discovery. On startup the agent refreshes the model catalog from `catalog.stencil.so` (cached, conditional, falls back to the bundled list) and asks several model providers for their public model lists.
- `share`, `collab`, `stream` and the skill registry still default to OMP's services. They run only on an explicit command.
- Provider sign-in routes and their request headers.
- Native sign-in helper state stays under `~/.scient-agent/oauth` even when a host assigns a root. A URL-scheme handler is registered once per user, and that folder holds the lease that keeps two agent processes from registering it at once. OMP uses the same URL schemes with its own lease, so on macOS and Linux Scient Agent refuses to start a sign-in while an OMP sign-in helper holds the scheme, and checks again just before it registers its own. The two products cannot fully exclude each other: a stock `omp` does not know Scient Agent's helper, so starting the same vendor's sign-in in both at once can make one of the two attempts fail. Windows has no such check yet.
- What the agent calls itself to another program or service: the `originator` and the `User-Agent` that some provider requests carry, the terminal handshake, Warp's agent name. These are part of how a service recognizes the client.
- The line a background process of the agent prints when it is ready (`omp lsp mux listening on ...`). The pattern that waits for it is saved with the process's record, so a later build must print what an earlier build waits for.
- The message that says Oh My Pi holds a sign-in link: it is about the other product.
- Benchmark tooling (`packages/metaharness`, `packages/typescript-edit-benchmark`) and the sentence about RoboOMP, upstream's issue bot: there `omp` is the agent they run.
- The terminal interface's π logo and icon: the symbol has no terminal drawing yet. Scient drives the agent over RPC, where neither shows.
- The built-in welcome image, changelogs and READMEs, and the names of tuning variables (`PI_*`, `OMP_*`) where the documentation mentions them.

## Branches, releases and upstream updates

- `main` holds Scient Agent. Changes reach it through pull requests that keep their commits (rebase merge; history stays linear). A release is a `v<version>` tag on `main` that matches `scient.json`: `v0.1.0`, `v0.1.1`, ...
- Scient's commits come in three kinds: the scripts under `scripts/scient/`, generated commits (the output of `rename-identity.ts` or `rename-wording.ts` and nothing else, subject ending in `(generated)`), and hand-written changes. A pull request that changes what a script produces carries the output as its own `(generated)` commit.
- `upstream` is a fetch-only remote for Oh My Pi. `scient/18.4.8` is the branch the work started on, kept as it was.

Taking a newer Oh My Pi release is one source-alignment pull request, plus a Desktop compatibility change only if the host contract needs one. Replay Scient's changes onto the exact upstream release, regenerate generated changes, and import the resulting tree into a branch based on Scient `main`. Do not rebase or force-push published Scient history. The agent loop, tools, Skills, MCP, interpreters and delegation remain inherited; an alignment is not a new feature-selection exercise.

### Prepare an intake

1. Record the current Scient `main` SHA, the accepted upstream commit in `scient.json`, the target release tag and its resolved full commit SHA. Fetch the target into `refs/upstream-tags/`, not Scient's product tag namespace. Confirm `origin` is ScientFactory and `upstream` is the official OMP repository with a disabled push URL.
2. Use dedicated clean replay and integration worktrees outside any running app's checkout. Leave live profiles, credentials, sessions and unrelated dirty work alone. Freeze the target for this intake even if OMP publishes another release during the work.
3. Inventory Scient patches before replay. For the first alignment, use **all** commits from the recorded 18.4.8 base through the frozen Scient `main`, not just `scient/18.4.8`: that historical branch excludes later sign-in metadata, platform-release and isolation-check work. After a completed alignment, use the accepted replay tag's Scient delta from its recorded upstream base, followed by owned commits after the corresponding `sync:` import. Record every patch as retained, adapted or retired, with the reason. Regenerate commits ending in `(generated)` instead of cherry-picking them.
4. Inspect upstream's complete range by history and file scope, then examine affected Scient seams and breaking changes in detail. Record review coverage honestly; a changelog digest is not a correctness audit of every upstream commit. Include new state/environment overrides, discovery, credential storage, RPC commands, session formats and native-build/release changes.
5. Keep a dated intake receipt with the pins, patch inventory, resolutions, commands/results, omissions, Desktop commit, replay commit/tree and eventual PR/merge/release references. Preparation, source qualification, Desktop qualification, merge and publication are separate statuses. Do not advance an accepted checkpoint simply because a release was fetched.

### Replay and import

Build a candidate branch from the pinned upstream commit. Port the generator scripts and their later fixes before the relevant generation step, regenerate identity, adapt hand-written patches in dependency order, and regenerate wording. A blind cherry-pick of every non-generated commit is not sufficient when upstream moved or replaced a subsystem. `rename-wording.ts` stops when a listed text disappears: inspect the new source and repair the mapping rather than dropping the check.

Update `scient.json` with the exact upstream pin and the chosen Scient product version. Review inherited workflows as well as source: preserve Scient's release authority and do not activate upstream publication, updater, reporting or repository-management automation. Run the checks below and affected upstream tests; list intentional exclusions and failures rather than claiming the entire upstream suite passed.

Only once the replay candidate is qualified, import its tree into a **clean, disposable integration worktree** based on the frozen Scient `main`:

```sh
# <candidate> is the reviewed replay commit, not a moving upstream branch.
git status --porcelain                    # must be empty; stop otherwise
git read-tree -u --reset <candidate>       # replaces this worktree's index and files
git diff --cached --stat
git commit -m "sync: Oh My Pi <new>"
git rev-parse HEAD^{tree} <candidate>^{tree} # must print identical tree IDs
```

The tree replacement is destructive to uncommitted files; never run it in the primary checkout or an active app worktree. Open the PR from the integration branch. If `main` advances before merge, incorporate those owned changes into the candidate and requalify; do not overwrite them with the older frozen tree.

After acceptance, preserve the exact replay commit under an immutable `omp-sync/v<new>` tag for the next intake and record it with the owned merge commit. Until then it is a candidate branch, not an accepted sync tag. This tree-import method preserves upstream history in the replay ref but **does not add the new upstream commit as an ancestor of Scient `main`**. `scient.json` records the source-content baseline; it must not be presented as a literal Git integration base. Keep the replay ref reachable on the owned remote when delivering the alignment. Do not rewrite existing replay or product release tags.

### Qualification and rollback

- Run the maintained Scient checks and isolation probe against the actual compiled candidate, including new incoming environment/state overrides. Exercise two native builds on the same OMP version to protect content-addressed addon identity.
- Run affected upstream tests for authentication/model discovery, sessions, RPC, worker lifecycle and native loading. Adapt assertions only where Scient deliberately differs. Re-read the target's build scripts and toolchain requirements; the current release's build instructions are not evidence that a newer target builds.
- Against a recorded current Desktop commit and isolated homes, exercise a real turn, Skill loading, MCP use, code execution/artifacts, subagents, background completion, cancellation and continue/resume. Include sign-in listing, sign-out, sign-in completed by another process, custom models and persisted sessions from Scient 0.1.0. Keep external OMP and native Scient running independently. Existing live suites are the starting point, not proof of untested new RPC/UI categories.
- RPC version numbers alone do not establish compatibility. Preserve the deployed Desktop contract or deliver and qualify an explicitly paired host change before distributing the agent. Test the candidate through managed-runtime installation and runtime identity checks, not only a source CLI invocation.
- Separate inherited runtime improvements from new host/UI support. New RPC controls, voice events or Tern/TUI views do not automatically become Desktop features; record the useful host additions separately without making full upstream UI parity a prerequisite for aligning the runtime.
- Complete platform CI and artifact checks before release; publish separately under the release procedure below. Keep the previous binary and a copy of pre-upgrade test state. A source revert or binary downgrade is not a safe persisted-state rollback unless that downgrade has been tested.

### First alignment intake — 2026-10-08

This is a **locally qualified macOS ARM64 candidate, not a merged or published alignment**:

- Owned `main`: `25bce7b1c4094b8fd588327857cea7f7497abc56`; published Scient Agent `v0.1.0`.
- Accepted source baseline: OMP `18.4.8`, `717f97f4d22b3d65c4a4eef6a744255d46f4d1a6`.
- Target observed/fetched: OMP `18.8.4`, `40e9368ef0458fd9073329cdff4174895f91bc6b`, under `refs/upstream-tags/v18.8.4`.
- First replay inventory: 38 owned commits, including three generated commits. Non-generated commits touch 101 paths; 45 of those are also touched upstream. This is review overlap, not a measured merge-conflict count.
- Desktop qualification is frozen at `d263cacbc91a8973dbb3de3c98929e2e8cfafddc`, in a separate test-only checkout with synthetic state.

Adaptations implemented in the candidate:

| Seam | Incoming change and required preservation |
|---|---|
| Sign-in/sign-out | Retained `get_logout_accounts` and account-specific sign-out, and preserved Desktop's `{ type: "logout", providerId }` contract plus Scient sign-in metadata. Both sign-out paths refuse broker-owned credentials. Updated the wire command owner and regenerated its TypeScript, Python, Rust and Go artifacts. |
| Model/session ownership | Retained model-less RPC startup without overriding an explicit missing model. Adapted sign-in refresh to upstream's registry caches and local/broker `revalidate()`, retaining discovered catalogs. Account logout refreshes only its discovery and always reapplies credential hooks. Shared model lookup covers `set_model` and session restore; the disposable 0.1.0 persisted-session proof passed. |
| Native state | Renamed new `PI_NATIVES_DIR` to `SCIENT_AGENT_NATIVES_DIR`; host roots override it in both native loader and shared directory resolver. Global daemon and session-owner paths also honor each host root under XDG. Retained content-addressed loading while adopting upstream's in-memory addon embedding API. Added decoy and two-host regression tests. |
| SDK identity | Moved the Python client's Scient executable default with the upstream relocation to `sdk/python/omp-rpc`. Kept plugin/package/wire identities that are compatibility formats. |
| Build/release | Built the addon with pinned Rust `nightly-2026-10-06` and Bun `1.4.2`, adapting the compile/embedding API without restoring obsolete on-disk generation. Replaced three ungated unstable `map_or_default` calls in `pi-vfs` with equivalent stable expressions. Preserved Scient's six-platform workflow and release authority; no upstream publisher was activated. |

Source replay, native compilation and local source/Desktop qualification are implemented. Results and omissions are recorded below; no PR, accepted sync tag, merge or release has been created. The running Scient Agent Review app and its state remain untouched.

The inherited human-written PR-sentence requirement was removed from `CONTRIBUTING.md`, `AGENTS.md` and the PR template. AI-assisted descriptions are allowed with contributor accountability. The broader contribution policy remains for a later Scient-specific review.

#### Patch disposition

Every one of the 38 prior owned commits is accounted for. The 35 non-generated patches remain implemented; eight related model-refresh patches were consolidated for the new registry rather than copied mechanically. Three old generated commits were replaced by fresh output. No inherited execution capability was retired.

| Prior Scient commit | Replay commit | Disposition |
|---|---|---|
| `3d7f0af372` | `5f44b60e41` | Retained generator |
| `cc3f77c252` | `3cd8f9b0bb` | Retained generator |
| `02029f031c` | `ebd2928504` | Retained generator |
| `38a33a6180` | `adac5baad1` | Retained generator |
| `8bb54a64d7` | `16058ddb90` | Retained generator |
| `a508bfce8e` | `3dedfc0bf8` | Retained generator |
| `68a787f969` | `df70c4fb8d` | Adapted native embedding/cache |
| `c8481cc944` | `f765fa1086` | Adapted upstream product services |
| `cd9b01626c` | `229650fc0e` | Retained prompt identity |
| `5f3f6d6520` | `9d9c1be0b8` | Adapted product/root identity |
| `945d731c08` | `b6310ba102` | Adapted guide/isolation/CI |
| `48d1c171f6` | `ae12d1ccf1` | Adapted authoritative host root |
| `6530b80988` | `fe24f51c5d` | Retained launch-only root |
| `26852fcaef` | `3a1007d8dd` | Adapted model-less RPC startup |
| `e23903f51e` | `fba85f9926` | Adapted dual sign-out contract |
| `39018d18e3` | `4f59a9aae9` | Retained sign-out failure reporting |
| `66bf579f0a` | `921e062a27` | Adapted stored sign-in/key metadata |
| `169a90dd39` | `16fadc9197` | Retained broker sign-out refusal |
| `489d51c369` | `e0f6845883` | Retained active-store authority |
| `4dbf8d00bb` | `3a74c9aa77` | Retained shared-store metadata |
| `d090039a59` | `e90f2f0921` | Adapted relocated Python SDK |
| `37af107f0c` | `0c38d77720` | Retained worker product version |
| `e9304567c9` | `e716cfba9c` | Retained wording checks |
| `1ae7672c8f` | `3edc2b8131` | Retained Scient symbol |
| `8cb3166c15` | `4c21c6c468` | Retained owned branch/signing policy |
| `d7b2aac071` | `1829c053dd` | Adapted six-platform release |
| `25bce7b1c4` | `76a7ff129c` | Retained textual shell-environment probe |
| `17b762c73e`, `cd6b9b9aca`, `680d94d9de`, `eaff1658ce`, `1490480ef0`, `60bcddebd8`, `0efc9cd7a5`, `9a22de8fd4` | `8f4d3840f3` | Consolidated credential-aware model refresh; later account logout fix in `ebf2b611df`. |
| `ce474c5892`, `ebb2c264e1`, `c4656a2a71` | `a208f89f23`, `e5b8e79dee` | Regenerated identity and wording. |

Additional fixes cover the incoming native override, global daemon/session-owner XDG isolation, generated sign-in metadata, account logout catalog preservation, portable VFS defaults, native branding expectations and the pinned formatter. Independent source review found three ownership/contract defects; all were fixed and independently re-reviewed. Regression tests also cover discovery rejection after account removal.

#### Local qualification

The delivery rebuild came from clean replay commit `7f21a225cd4a099cc40db7f40a6c3a96fbd492bc`. Its macOS ARM64 binary reports build ID `7f21a225cd4a`, product `0.1.1`, upstream `18.8.4`, RPC `[1,2]`, SHA-256 `802583e42400cb6c09db0a8558fa1c78be5a9c9f6becd84ac66f2ce79c2f6db3`. Compiled isolation, capability/upgrade, nine Desktop live suites, coexistence and managed installation were confirmed against this rebuild. Later changes to this receipt do not alter runtime code. This is an ad-hoc-signed local candidate, not a notarized release artifact.

| Check | Observed result |
|---|---|
| Frozen install, identity/wording generation, TypeScript lint/format and package types | Passed. |
| Rust format/clippy, forced with `CI=1` | Passed using the pinned toolchain. |
| Rust tests, `CI=1 NEXTEST_TEST_THREADS=1 bun run test:rs` | 3,232 passed, 5 skipped; one runnable doctest passed. |
| Utils / native JavaScript packages | 842 passed, 13 skipped / 154 passed, 1 skipped. |
| Affected model/RPC/session seams / auth seams | 861 passed / 56 passed. |
| Focused Skills, eval, delegation and MCP source cases | 130 passed; overlaps some sign-in coverage below. |
| Final sign-in/reload/wire regressions | 26 passed, including remaining-account reprojection, unrelated catalog preservation and rejected-discovery handling. |
| Desktop RPC/session/content controls / orchestration cases | 166 passed / 159 passed. |
| Nine actual-binary Desktop suites | Final serialized confirmation: 22 passed using `vp test run --no-file-parallelism`. Covers custom models/refresh/barrier, Scient MCP and authority, native delegation, background wake/Stop/message, fork/restart and large image/frame handling. |
| Scient identity/state/sign-in and stock OMP coexistence | 7 passed, 1 real-model case skipped; includes six conversations per product, independent stop and no remaining child processes. |
| Desktop managed-runtime/connection/driver checks | 44 passed, including actual candidate checksum, materialization, identity smoke, RPC-v2 qualification and activation. Only download was supplied locally. |
| Compiled startup isolation probe | Passed; contacts are reported, not claimed absent. |
| Maintained compiled capability/upgrade probe | Passed: native Skill text reaches the model, JavaScript computes 42, shell produces an artifact, two children overlap and complete, published 0.1.0 sessions reopen and continue. Pre-upgrade snapshot rollback passed. |

Counts are per suite and must not be summed as unique coverage. Desktop qualification uses the frozen base above plus **test-only** changes through `8999349da26c84c6b4601264c5c6d829bfb697ec` on `qualify/scient-agent-omp1884-20261008`; production Desktop code is unchanged. The fixtures supply a guarded empty app-owned-child Stop obligation, ephemeral custom-model endpoints, explicitly configured uncalled models, and a local-download/real-managed-qualification case. The endpoint assertions check actual POST path, model, streamed request, synthetic authorization and user text; managed installation checks the selected version as well as executable bytes and process admission, with scoped cleanup on Effect failure/interruption. Both strengthened files pass all 14 cases; the final scoped managed file passes all 10 cases. The local managed artifact proves installation/qualification behavior, not a published catalog's checksum provenance or a real release download.

Failure history remains part of the evidence: the old Stop fixture failed identically on published 0.1.0 because a mock method was absent; repaired baseline and candidate pass. Two prior live cases required an unavailable Ollama model; their registration/refresh/adapter assertions now use a loopback SSE stub. Credential-free setup/coexistence needed explicit model configuration. Initial native timestamp and Desktop process timeouts passed on focused reruns and complete confirmation runs. The delivery parallel run had two eight-second startup-deadline failures, followed by extra shutdowns from session-open retries; all nine suites passed in a serialized confirmation without changing the deadline or shutdown assertions. The separate twelve-conversation coexistence/load case passed; it does not erase those parallel-suite failures or qualify startup under arbitrary machine load. Parallel Rust desktop-input tests contended on their real machine-global lock; serial qualification passes without weakening it. Logs from this run are local under `/tmp/scient-agent1884-qualification.tKoGnA`; the repeatable compiled proof is [capability-check.ts](scripts/scient/capability-check.ts).

This is not a complete correctness/security audit of all 2,093 incoming commits. Real hosted-model/OAuth completion, Python runtime provisioning, Electron visual acceptance, Linux/Windows/Intel-macOS execution, signed/notarized artifacts and hosted six-platform CI were not performed here. New upstream RPC categories are inherited, not automatically exposed in Desktop. Directly running 0.1.0 against upgraded state was **not** qualified: use the retained pre-upgrade snapshot for rollback. No PR, push, accepted sync tag, merge or publication has occurred, and no running app/profile was restarted or migrated.

### Recurring cadence

Check upstream releases at least weekly and before each Scient Agent release; use a daily read-only digest if OMP's pace warrants it. Prepare one bounded release alignment at a time, with urgent security/compatibility fixes handled sooner. Monitoring reports movement; it never merges code or advances accepted pins. This repository currently has release/build CI, **not an automated upstream monitor**. The procedure above is manual until a separately implemented read-only monitor and accepted receipt/checkpoint format exist.

## Build

Needs Bun 1.4 or newer, `rustup` with the pinned toolchain and components in `rust-toolchain.toml`, CMake and Ninja. Ensure that toolchain's `cargo`, `rustc` and `rustfmt` precede a separate system Rust installation on `PATH`; a Homebrew stable compiler can otherwise be selected by the native build's child processes.

```sh
bun install --frozen-lockfile
bun run build:native                          # Rust addon for this machine
bun --cwd=packages/coding-agent run build     # packages/coding-agent/dist/scient-agent
```

## Checks

```sh
bun scripts/scient/rename-identity.ts --check   # no OMP state name is left in the source
bun scripts/scient/rename-wording.ts --check    # the agent's words name Scient Agent
bun run check:ts
CI=1 bun run check:rs                         # force checks even on a clean committed tree
CI=1 NEXTEST_TEST_THREADS=1 bun run test:rs    # native desktop-input tests share a machine lock
bun --cwd=packages/utils test
bun --cwd=packages/natives test
bun scripts/scient/isolation-check.ts packages/coding-agent/dist/scient-agent
```

`isolation-check.ts` starts the built binary in empty home directories, with every OMP state variable pointing at a decoy and a proxy recording what it tries to reach. It fails if the agent writes its own state outside its config root, follows one of OMP's variables, touches an OMP home, hands its shell a variable that would steer a stock `omp`, or contacts an OMP service or update source unasked. It prints the hosts contacted. It does not limit what a task may write or reach.

It runs without a model, so it covers startup, the RPC handshake and the agent's shell. Scient Desktop's live suites (`OMP_QUALIFY_TARGET=scient`) cover model turns, subagents, background work and sessions against the same executable.

`capability-check.ts` accepts absolute candidate and previous-binary paths. Run its controller with a disposable HOME as well. It uses isolated child roots and a loopback model stub, and retains synthetic fixture receipts for inspection. It exercises actual native Skill reads, JavaScript eval, shell artifacts, two concurrent children, old-session upgrade and pre-upgrade-snapshot rollback. It does not call a paid model or validate hosted-model judgment. For Desktop coexistence, use a **stock OMP** binary in `OMP_QUALIFY_BINARY` and the native candidate in `SCIENT_AGENT_QUALIFY_BINARY`; `OMP_QUALIFY_TARGET=scient` is for the separate common-suite run, not the coexistence suite.

Upstream's tests are rewritten together with the wording they expect. The rest of upstream's suite is not part of Scient's checks yet: some of its tests assert behavior Scient changed on purpose (state locations, updates, the startup checks).

## Release

`.github/workflows/scient.yml` builds and checks every platform on every push to `main` and on every pull request into it: macOS (Apple silicon and Intel), Linux (x86-64 and ARM64, glibc) and Windows (x86-64 and ARM64), each on its own GitHub-hosted runner, each with the isolation check. On x86-64 the binary carries the `modern` (AVX2) and `baseline` native addons (`PI_NATIVE_X64_VARIANT` builds each). Pushing a `v<version>` tag that matches `scient.json` also signs and notarizes the macOS builds and drafts a GitHub release with every binary and its SHA-256. A person publishes the draft. Not built yet: Linux with musl (Alpine). The Windows builds are not code-signed.

Signing uses the same five repository secrets, in the same form, as Scient Desktop's release: `CSC_LINK` (the Developer ID Application certificate as a base64 `.p12`), `CSC_KEY_PASSWORD`, `APPLE_API_KEY` (the App Store Connect `.p8` key's text), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.
