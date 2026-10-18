# Scient Agent: maintainer guide

Scient Agent is the native research agent of [Scient](https://github.com/ScientFactory/scient-desktop). It is built from [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP): it inherits OMP's agent runtime whole and changes what makes it a separate product. A machine can run Scient Agent and a stock `omp` side by side without either reading, changing, or updating the other.

`scient.json` records the product version and the exact upstream release this tree derives from.

## What Scient changes

Everything else is upstream's code and behavior.

| Area | Change |
|---|---|
| Name | The executable is `scient-agent`, and shell profile aliases run it. `--version` prints `scient-agent/<version>`; `--runtime-info` prints a JSON description (product, version, upstream release and commit, RPC versions, build id) for hosts. Process titles, log files and Windows named pipes carry the name. |
| Wording | The agent calls itself Scient Agent, and its command `scient-agent`, wherever a person or a model reads its words: messages, help, sign-in instructions, prompts, the built-in documentation, window and notification titles. The prompts also address researchers: the model's role is a research and coding assistant, and each personality matches its explanations to the reader's expertise instead of assuming a technical reader. `scripts/scient/rename-wording.ts` generates this. |
| State | The config root is `~/.scient-agent` (project folder `.scient-agent/`), or the absolute directory a host sets in `SCIENT_AGENT_ROOT`. User config lookups, the native addon cache, browser storage state and crash logs follow it. A host's root is authoritative: `SCIENT_AGENT_DIR` is ignored under it, and a `.env` in the project or the home directory cannot set any `SCIENT_AGENT_*` variable (a `.env` inside the root can). The root is taken only from the launch environment, never from a `.env`. Standalone use keeps upstream's `.env` overrides. |
| Variables | The variables that choose where state lives have `SCIENT_AGENT_*` names: `CONFIG_DIR`, `CONFIG_FILES`, `DIR`, `PROFILE`, `SESSION_DIR`, `WORKTREE_DIR`, `AUTH_BROKER_*`, `NATIVES_DIR`, the cache database overrides, and the runtime directory, socket and configuration variables the agent hands its own workers. OMP's names for them are ignored. Tuning variables (`PI_*`) are unchanged. |
| Discovery | A host can add foreign user-level sources with `SCIENT_AGENT_ENABLE_SOURCES` (provider ids separated by commas or whitespace). These are unioned with `enabledProviders` for discovery without changing or persisting that setting; `disabledProviders` still wins. The same aliases apply, including `claude` enabling `claude-plugins`. Under a host root, project and home `.env` files cannot add sources. |
| Native addon cache | A compiled binary extracts its addons into a directory named for their content, so two builds on one upstream version never load each other's, and it loads only from that directory. A modern addon that fails to load falls back to the same build's baseline addon; an addon found beside the executable is not a fallback. |
| Symbol | The sign-in page every browser sign-in ends on and the `stats` dashboard show Scient Agent's symbol (`packages/utils/src/scient/scient-agent-symbol.svg.txt`, the file Scient Desktop shows for the agent; copy it over when the symbol changes) in Scient's colors. |
| Shared workers | The tiny model worker and the shared embedding server are reused while their launch tag matches. The tag carries the product version, not the upstream package version, so a new Scient Agent release replaces a worker an earlier release left running. |
| Updates | `scient-agent update` only updates plugins. The startup update check and the startup marketplace refresh are off, and Oh My Pi's background auto-update is never offered or started. A host or installer replaces the executable. |
| Reporting | Automatic tool-issue reports to OMP's service are off by default. |
| Shell traces | The bash tool records no execution trace unless the user turns `display.shellVisualization` on. Scient Agent's host draws no shell visualization, and every live frame of a running command would carry the whole trace, up to megabytes. |
| Browser relay | The relay listens on port 9324 (OMP uses 9224), so each product runs its own. |
| HTML exports | Oh My Pi's binaries load the export viewer from its CDN. Scient's viewer differs by its wording, so a compiled Scient Agent carries its viewer inside the exported page. The page still loads two pinned libraries from `stencil.so`. |
| Stats dashboard | The dashboard's tab icon is Scient Agent's symbol. With `SCIENT_AGENT_HOST_PAGES=1` the agent reports the dashboard's address and opens no system browser, so a host can show it. |
| Sign-ins | Over RPC the agent starts without a model (a host signs in and picks one afterwards; a model named with `--model` that cannot be resolved still ends the run). `get_login_providers` includes optional `emails` containing active stored OAuth identities, without tokens or keys; absent provider metadata stays absent. It also reports each entry's `kind` (`account` or `key`) whether a sign-in is `stored`, and the `store` it is kept under: two entries with one `store` are two ways to sign in to one account and share status and sign-out. `logout` without `credentialId` removes an entry's stored sign-ins and fails when the store still holds them afterwards; with an integer `credentialId`, it retains upstream's per-account removal and reports remaining authentication. When the active credential store is an auth broker's snapshot (`credentials.heldByBroker`), the broker owns the sign-ins: they are listed as not stored and `logout` is refused. `set_model` re-reads the sign-in store before it reports a model as missing, so a session that was already running finds a sign-in completed in another process. It revalidates the active local or broker-backed store and runs the sign-in hooks again (`ModelRegistry.reapplySignInProjections`), and rediscovers that provider's models only when the session holds no discovered catalog for it. No static reload runs, so nothing that was usable is lost. A model that only a second account of an already discovered provider has is still reported missing until the session restarts. |

Left as upstream, on purpose:

- Internal package names (`@oh-my-pi/*`) and package versions. The native addon is stamped with and checked against the package version.
- The `omp://` internal URL scheme, the `.omp-plugin` marketplace format, the `${OMP_PLUGIN_ROOT}` substitution and the `omp` key in a plugin's `package.json`: these are formats plugins are written against.
- Which configuration is discovered, apart from the host's additive opt-in above. Another agent's folder in the home directory (`~/.claude`, `~/.codex`, ...) requires an opt-in through `enabledProviders`, `SCIENT_AGENT_ENABLE_SOURCES`, or upstream's explicit discovery roots; the same folders in a project are read, as upstream does. Scient Agent does not read `.omp` anywhere.
- Model discovery. On startup the agent refreshes the model catalog from `catalog.stencil.so` (cached, conditional, falls back to the bundled list) and asks several model providers for their public model lists.
- Syntax grammars the executable does not bundle are downloaded on first use from the `stencil-hq/wasm-grammars` releases on GitHub (`PI_GRAMMARS_URL`). Each is checked against a pinned SHA-256 and kept in the natives folder.
- `share`, `collab`, `stream` and the skill registry still default to OMP's services. They run only on an explicit command.
- Provider sign-in routes and their request headers.
- Native sign-in helper state stays under `~/.scient-agent/oauth` even when a host assigns a root. A URL-scheme handler is registered once per user, and that folder holds the lease that keeps two agent processes from registering it at once. OMP uses the same URL schemes with its own lease, so on macOS and Linux Scient Agent refuses to start a sign-in while an OMP sign-in helper holds the scheme, and checks again just before it registers its own. The two products cannot fully exclude each other: a stock `omp` does not know Scient Agent's helper, so starting the same vendor's sign-in in both at once can make one of the two attempts fail. Windows has no such check yet.
- What the agent calls itself to another program or service: the `originator` and the `User-Agent` that some provider requests carry, the terminal handshake, Warp's agent name. These are part of how a service recognizes the client.
- The line a background process of the agent prints when it is ready (`omp lsp mux listening on ...`). The pattern that waits for it is saved with the process's record, so a later build must print what an earlier build waits for.
- The message that says Oh My Pi holds a sign-in link: it is about the other product.
- Benchmark tooling (`packages/metaharness`, `packages/typescript-edit-benchmark`) and the sentence about RoboOMP, upstream's issue bot: there `omp` is the agent they run.
- The terminal interface's π logo and icon: the symbol has no terminal drawing yet. Scient drives the agent over RPC, where neither shows.
- The built-in welcome image, changelogs and READMEs, and the names of tuning variables (`PI_*`, `OMP_*`) where the documentation mentions them.

## Keeping Scient's changes apart

Scient Agent follows every Oh My Pi release. Each alignment replays Scient's changes onto the new release, and its cost is set by how much of Scient sits inside Oh My Pi's files: a line Scient edited conflicts whenever upstream edits it or the line beside it, and a file Scient owns never does. Keeping Scient apart is therefore the first rule of every change in this repository, before convenience and before a smaller diff today. It also keeps the code readable: Scient's behavior is found in Scient's files, and Oh My Pi's code reads as upstream wrote it.

Every difference from Oh My Pi takes the first of these forms that works:

1. **No change.** Use what Oh My Pi already offers: a setting, an environment variable, a flag, an extension or a plugin. A fix that Oh My Pi itself needs is proposed upstream; until it lands it is a hook like any other, and its ledger entry says so.
2. **Generated.** A mechanical change is a rule in a generator, never a hand edit. The names a program or the system reads (state folders, variables, pipes, the executable, log, helper and service names, ports) are `rename-identity.ts`'s; the words a person or a model reads are `rename-wording.ts`'s. A rule names exactly what it rewrites, and a rule whose text upstream moved stops the generator with the file and the text. An alignment regenerates both instead of resolving their conflicts, and the tests that expect a name change with the code that has it.
3. **Scient's own files.** Logic, types, constants, messages and tests live in files Scient adds, under a `scient/` folder: `scripts/scient/`, `packages/<package>/src/scient/`, `packages/<package>/test/scient/`, `packages/natives/native/scient/`. The path alone shows that a file is Scient's, and the generators never rewrite one. The few owned files elsewhere are listed in the ledger: `SCIENT.md`, `scient.json`, `.github/README.md` (which GitHub shows in place of Oh My Pi's README) and `.github/workflows/scient.yml`.
4. **A marked hook.** What has to happen inside an Oh My Pi file is a hook into Scient's code:
   - **Small.** An import, a call, a guard or a changed value. Anything with logic of its own is a function in Scient's files that the hook calls.
   - **Added rather than edited.** Add lines beside Oh My Pi's instead of changing them: a separate `import` statement rather than a name in upstream's list, a guard before a statement rather than a rewritten condition, a wrapper around upstream's expression (`workerTag(upstreamTag)`) rather than a new one.
   - **One owner per file** where it can be, so a conflict names one contract.
   - **Around Oh My Pi's code, not into it.** Never reformat, rename, reorder or re-comment upstream lines around a hook.
   - **Oh My Pi's tests stay as written.** Scient's tests go in Scient's test files, and a generator renames what an upstream test expects together with the code. Only a test of behavior a contract changes on purpose changes by hand, in a marked block of that contract, so it asserts what Scient Agent does.
   - **Marked**, in the file's own comment syntax:

   ```ts
   // scient(SA-AUTH): begin - A sign-in completed in another process reaches a running session.
   ...the changed lines...
   // scient(SA-AUTH): end
   ```

   `#` replaces `//` in Python, YAML, TOML, shell and Bazel files, `<!-- ... -->` in Markdown, HTML, SVG and XML, and `{/* ... */}` inside JSX. A marker is a comment of its own, never a line inside a string, a template, a block comment, a code block, an HTML attribute or raw text such as `<textarea>` or `<title>`; a change inside such text is wrapped from outside it, or made by a generator. The checker reads JavaScript and TypeScript with their parser, Markdown by rendering it and reading the HTML with an HTML tokenizer, and Rust with a lexer to hold this, and reports a file they cannot read unambiguously; in other languages review does. A removal leaves a block where the lines were; where blocks sit side by side, review decides which of them explains it. The checker cannot tell a hook retired right beside a generated line from a deletion: retire such a hook at the next alignment by leaving its contract out of the replay. Blank lines a change adds go inside its block, or the block ends directly before the next line of Oh My Pi's code.

`scripts/scient/divergences.json` is the ledger: one entry per contract (`SA-AUTH`, `SA-ROOT`, ...), naming what stays true, the files Scient owns, the Oh My Pi files that carry its markers, and any Oh My Pi file it deletes, changes by JSON pointer (JSON holds no comments), or changes without markers because a marker would change what the file does. An entry that upstream absorbed or Scient dropped stays as `upstreamed` or `retired`, with its disposition.

`scripts/scient/divergence-check.ts` enforces this in CI. On an ordinary pull request it checks every commit after the accepted alignment: a hand-written change to an Oh My Pi file must sit in a block whose entry lists that file, and every file Scient adds must have an owner. On an alignment pull request it checks every commit of the new replay, regenerates each generated commit from its parent to prove it is exactly the generator's output, and requires the pull request's tree to equal the replay's. It shows provenance and coverage, not that a change is minimal or correct: review holds a change to the rules above.

It also measures. Every run reports Scient's footprint in Oh My Pi's code, the marker blocks, the lines inside them and the files they are in, and `--footprint` breaks it down by contract. Each alignment receipt records the footprint, and a pull request that grows it says why.

Generated RPC clients (`rpc-wire.schema.json`, `rpc-wire.generated.ts` and the Python, Rust and Go clients) change only in a `Scient-Generator: rpc` commit, including a rename or removal, and the checker regenerates them whenever their sources change. Dependencies are installed without lifecycle scripts before a generator runs, and the generators run the oxfmt that `fmt:tools` names directly rather than through `bun run`, so no package script can shape a generated commit. What a hand-written commit adds and what it removes are each accounted for. Code returned to Oh My Pi's needs no marker and a JSON value returned to Oh My Pi's needs no registration, so restoring upstream code is never flagged. Retiring a block or a registration means restoring what it covered, or covering it another way. That holds even for a commit that changes only the ledger.

An alignment is accepted with an annotated tag `omp-sync/v<version>` on its replay whose message ends with `Scient-Checkpoint: <commit>`: the commit on `main` the alignment merged as, whose tree equals the replay's. Ordinary pull requests are checked from that commit. An alignment pull request's replay is the branch `replay/omp-v<version>` on `origin`; CI checks it while no tag exists for the new version.

The 18.8.4 alignment predates markers; its in-place changes were accepted with it. From the 18.10.4 alignment on, every hand-written change is marked or registered.

## Branches, releases and upstream updates

- `main` holds Scient Agent. Changes reach it through pull requests that keep their commits (rebase merge; history stays linear). A release is a `v<version>` tag on `main` that matches `scient.json`: `v0.1.0`, `v0.1.1`, ...
- Scient's commits come in three kinds: the scripts under `scripts/scient/`, generated commits (the output of one generator and nothing else, subject ending in `(generated)`, trailer `Scient-Generator: identity`, `wording` or `rpc`), and hand-written changes (trailer `Scient-Divergence: <ids>` in a replay). A pull request that changes what a script produces carries the output as its own generated commit.
- `upstream` is a fetch-only remote for Oh My Pi. `scient/18.4.8` is the branch the work started on, kept as it was.

Taking a newer Oh My Pi release is one source-alignment pull request, plus a Desktop compatibility change only if the host contract needs one. Replay Scient's changes onto the exact upstream release, regenerate generated changes, and import the resulting tree into a branch based on Scient `main`. Do not rebase or force-push published Scient history. The agent loop, tools, Skills, MCP, interpreters and delegation remain inherited; an alignment is not a new feature-selection exercise.

### Prepare an intake

1. Record the current Scient `main` SHA, the accepted upstream commit in `scient.json`, the target release tag and its resolved full commit SHA. Fetch the target into `refs/upstream-tags/`, not Scient's product tag namespace. Confirm `origin` is ScientFactory and `upstream` is the official OMP repository with a disabled push URL.
2. Use dedicated clean replay and integration worktrees outside any running app's checkout. Leave live profiles, credentials, sessions and unrelated dirty work alone. Freeze the target for this intake even if OMP publishes another release during the work.
3. Inventory Scient patches before replay. For the first alignment, use **all** commits from the recorded 18.4.8 base through the frozen Scient `main`, not just `scient/18.4.8`: that historical branch excludes later sign-in metadata, platform-release and isolation-check work. After a completed alignment, use the accepted replay tag's Scient delta from its recorded upstream base, followed by owned commits after the corresponding `sync:` import. Record every patch as retained, adapted or retired, with the reason. Regenerate commits ending in `(generated)` instead of cherry-picking them.
4. Inspect upstream's complete range by history and file scope, then examine affected Scient seams and breaking changes in detail. Record review coverage honestly; a changelog digest is not a correctness audit of every upstream commit. Include new state/environment overrides, discovery, credential storage, RPC commands, session formats and native-build/release changes.
5. Keep a dated intake receipt with the pins, patch inventory, resolutions, commands/results, omissions, Desktop commit, replay commit/tree and eventual PR/merge/release references. Preparation, source qualification, Desktop qualification, merge and publication are separate statuses. Do not advance an accepted checkpoint simply because a release was fetched.

### Replay and import

Build a candidate branch from the pinned upstream commit. Port the generator scripts and their later fixes before the relevant generation step, regenerate identity, adapt hand-written patches in dependency order, and regenerate wording. A blind cherry-pick of every non-generated commit is not sufficient when upstream moved or replaced a subsystem.

Since 18.10.4 a replay has one shape: the generators; the generated identity commit; one commit per active ledger entry, in ledger order, each with `Scient-Divergence: <id>`; the generated wording commit; the generated RPC commit. The next intake replays those contract commits. It does not replay the history that produced them, and a change made after an alignment is folded into its contract's commit. `rename-wording.ts` stops when a listed text disappears: inspect the new source and repair the mapping rather than dropping the check.

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

The tree replacement is destructive to uncommitted files; never run it in the primary checkout or an active app worktree. Before opening the PR:
- Check that every commit on `main` after the accepted `sync:` import is in the inventory as retained, adapted or retired. This applies even where upstream changed the same file.
- List the files the import changes that upstream's range did not (`git diff --name-only <main> <import>`, less `git diff --name-only <old upstream> <new upstream>`). Only the intended Scient changes may remain; anything else is a `main` change the replay is missing. This check is partial: it cannot see a missing change in a file upstream also changed, which the inventory covers.

Open the PR from the integration branch. If `main` advances before merge, incorporate those owned changes into the candidate and requalify; do not overwrite them with the older frozen tree.

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

Source replay, native compilation and local source/Desktop qualification are implemented. Results and omissions are recorded below. [Alignment PR #22](https://github.com/ScientFactory/scient-agent/pull/22) is open; the replay branch is reachable on the owned remote. No accepted sync tag, merge or release has been created. The running Scient Agent Review app and its state remain untouched.

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

The Scient-owned delta from the pinned upstream and the Desktop test delta pass `git diff --check`. The whole source import still reports inherited whitespace in `crates/pi-builtins/src/{host,tail}.rs` and context lines inside a Bazel patch; the same warnings exist in the raw upstream intake. These upstream files were left intact rather than altering patch semantics or adding unrelated formatting to the alignment.

Failure history remains part of the evidence: the old Stop fixture failed identically on published 0.1.0 because a mock method was absent; repaired baseline and candidate pass. Two prior live cases required an unavailable Ollama model; their registration/refresh/adapter assertions now use a loopback SSE stub. Credential-free setup/coexistence needed explicit model configuration. Initial native timestamp and Desktop process timeouts passed on focused reruns and complete confirmation runs. The delivery parallel run had two eight-second startup-deadline failures, followed by extra shutdowns from session-open retries; all nine suites passed in a serialized confirmation without changing the deadline or shutdown assertions. The separate twelve-conversation coexistence/load case passed; it does not erase those parallel-suite failures or qualify startup under arbitrary machine load. Parallel Rust desktop-input tests contended on their real machine-global lock; serial qualification passes without weakening it. Logs from this run are local under `/tmp/scient-agent1884-qualification.tKoGnA`; the repeatable compiled proof is [capability-check.ts](scripts/scient/capability-check.ts).

This is not a complete correctness/security audit of all 2,093 incoming commits. Real hosted-model/OAuth completion, Python runtime provisioning, Electron visual acceptance, Linux/Windows/Intel-macOS execution and signed/notarized artifacts were not performed during local qualification. New upstream RPC categories are inherited, not automatically exposed in Desktop. Directly running 0.1.0 against upgraded state was **not** qualified: use the retained pre-upgrade snapshot for rollback. No accepted sync tag, merge or publication has occurred, and no running app/profile was restarted or migrated.

Hosted six-platform build/isolation CI passed on PR #22 head `5ef8984870d64afdfb24f2286d76b1ecb9ccab5e`: all six "Build and check" jobs succeeded in [run 37784901473](https://github.com/ScientFactory/scient-agent/actions/runs/37784901473). The initial Linux ARM64 failure came from requiring `logs/` before the lazy logger emitted a record. The corrected probe permits quiet startup while retaining required-state, home, decoy and OMP checks; the two-host XDG regression also checks the resolved log path. Release-tag signing/notarization and draft release were skipped in this PR run and remain unqualified.

Review of that head found that OMP 18.8.4's `scripts/ci-macos-sign.sh` now signs on Linux with a pinned `rcodesign` and exits on macOS, where Scient's workflow called it, so every release tag would have failed to sign. The workflow now runs upstream's script unchanged on Linux, ad hoc on every run, and checks the signed bytes on macOS (see Release).

### Second alignment intake — 2026-10-15

This is a **replay built and checked locally, not a merged, tagged or published alignment**:

- Accepted source baseline: OMP `18.8.4`, `40e9368ef0458fd9073329cdff4174895f91bc6b`, from [PR #22](https://github.com/ScientFactory/scient-agent/pull/22) and its replay.
- Target: OMP `18.10.4`, `687892d1046ecaf18829b45f5b86928a308258f4`, under `refs/upstream-tags/v18.10.4`: 1,734 upstream commits after 18.8.4. Product version `0.1.1`.
- Inventory: the 44 commits of the 18.8.4 replay after its upstream base, and the owned commits after its import: the quiet-startup test, signing on Linux, and the divergence checker.

The replay has the shape described under "Replay and import": 15 commits, of which three are generated. Each hand-written commit is one ledger entry, and every hand-written change in an Oh My Pi file sits in a marker block or a ledger registration.

Adaptations to 18.10:

| Seam | Incoming change and what Scient keeps |
|---|---|
| Native addon cache | 18.10 embeds each addon as a zstd frame. The build id hashes the uncompressed addons, so each build still loads only its own. |
| Shared workers | 18.10.0 added a shared embedding server (mnemopi), reused while its launch tag matches. Its tag carries the product version, as the tiny model worker's does, and its socket and tag variables have `SCIENT_AGENT_*` names. |
| Sign-ins | The sign-in re-projection is rebuilt on 18.10's model finalization, so runtime model modifiers and catalog metrics survive it. Cloudflare Workers AI (18.9.2) is classified as a key sign-in, and a test now fails when an upstream custom sign-in hook is left unclassified. |
| Sign-in page | 18.10.4 serializes the page's state against injected markup. Scient's symbol and colors are added to Oh My Pi's template the same way, with replacer functions, and the template file stays as upstream wrote it. |
| Updates | One constant, `SELF_UPDATE` in `packages/coding-agent/src/scient/updates.ts`, stops the startup update check, instead of an edit at each caller. |
| State names | Windows pipe names in either escaping and relocated sockets under `/tmp/omp-*` carry the product's name. Rust files the generator changes are formatted with rustfmt. |
| Wording | The terminal notification title (18.10) names Scient Agent. |

#### Patch disposition

Every prior commit is carried by a contract commit; none was retired.

| Prior Scient commits (18.8.4 replay, then `main`) | Contract |
|---|---|
| `5f44b60e41`, `3cd8f9b0bb`, `ebd2928504`, `adac5baad1`, `16058ddb90`, `3dedfc0bf8`, `e716cfba9c` | Generators (`GEN-IDENTITY`, `GEN-WORDING`) |
| `a208f89f23`, `e5b8e79dee` | Regenerated identity and wording |
| `0c88f5ca17` | `SA-POLICY`; the incoming native-state override's name moved into the identity generator |
| `9d9c1be0b8` | `SA-PRODUCT`, with its root and reporting parts in `SA-ROOT` and `SA-SERVICES`; its names, and the relay's port, are the identity generator's |
| `ae12d1ccf1`, `fe24f51c5d`, `e2a2ea4d83`, `cb1f4ab4ba`, `5ef8984870` | `SA-ROOT` |
| `df70c4fb8d` | `SA-NATIVE-CACHE` |
| `f765fa1086` | `SA-SERVICES` |
| `3a1007d8dd` | `SA-RPC-START` |
| `fba85f9926`, `4f59a9aae9`, `921e062a27`, `16fadc9197`, `e0f6845883`, `3a74c9aa77`, `8f4d3840f3`, `ebf2b611df` | `SA-AUTH`; the root, build and release parts of `8f4d3840f3` are in `SA-ROOT`, `SA-BUILD` and `SA-RELEASE`, and its RPC clients are regenerated |
| `e90f2f0921` | The identity generator (the client's default executable) and the wording generator (its README) |
| `0c38d77720` | `SA-WORKER` |
| `3edc2b8131` | `SA-BRAND` |
| `229650fc0e` | The wording generator's labels |
| `73907cde58`, `700c489105` | `SA-BUILD` |
| `b6310ba102`, `4c21c6c468`, `1829c053dd`, `76a7ff129c`, `b1883a7ab1`, `d0bd8b236f`, `d2d198d241`, `b077dd9a4d`, `7f21a225cd`, `25ccdbbc21`, `1d9c15fabd`, `f183ff3b25`, `07fe6ad967`, the divergence checker | `SA-RELEASE` |

#### Separating Scient from Oh My Pi — 2026-10-16

Before this alignment was merged, its replay was rebuilt to take Scient as far out of Oh My Pi's files as it goes, and "Keeping Scient's changes apart" above was rewritten as the rules this followed:

- **Names became generated.** Most of the hand edits only put Scient Agent's name where a program reads it: the executable and its build outputs, process, log and helper names, XDG and temporary folders, service and client names, the browser relay's port and tab group, the Python client's default. They are rules in `rename-identity.ts` now, and the tests that expect those names change with them. Hand edits that the wording generator already produced (session and model hints, the license title, process titles) were dropped. The prompts' Scient wording and the Python client's README are wording labels. `SA-RELAY`, `SA-SDK` and `SA-PROMPTS` needed no hand-written change after that and left the ledger: what they kept true is now the generators' contract.
- **Logic moved into Scient's files.** The host root's rules (`utils/src/scient/root.ts`), the product version (`utils/src/scient/product.ts`), the native build cache (`natives/native/scient/build-cache.js`), sign-in listing and RPC sign-out (`coding-agent/src/scient/`), worker tags, the update switch, and the sign-in page's branding (`ai/src/scient/callback-page.ts`) are Scient's modules. The Oh My Pi files keep an import and a call: `rpc-mode.ts`'s logout is two lines instead of twenty, the native loader is three hooks instead of eight, and the sign-in page's HTML template no longer changes at all.
- **The build id moved out of Oh My Pi's build scripts.** Scient's workflow stamps it into `coding-agent/src/scient/build-id.ts`; four build scripts and two of their tests no longer change.
- **Scient's README is `.github/README.md`**, which GitHub shows; Oh My Pi's `README.md` stays as written instead of being replaced at every alignment.
- **Scient's tests left Oh My Pi's test files.** Five of Oh My Pi's tests change by hand. Four are under `SA-SERVICES`: they assume that issue reports are on by default or that `update` runs the self-updater. One is under `SA-PRODUCT`: it expects the User-Agent to carry the package's version.
- **The generators skip Scient's own files**, which say what they mean (some name Oh My Pi on purpose).

| | Before | After |
|---|---|---|
| Oh My Pi files with hand-written changes | 98 | 40 |
| Lines those changes add / remove | +1,104 / −1,002 | +341 / −76 |
| Marker blocks / lines inside them / files | 233 / 706 / 92 | 81 / 194 / 40 |
| Oh My Pi files with more than one contract's hooks | 2, with three contracts each | 2 (`dirs.ts`, `main.ts`), with two each |
| Replay commits (generated) | 18 (3) | 15 (3) |

Behavior is unchanged except where this list says otherwise:

- Oh My Pi's tests of the desktop notifier and the report bundle's logs had failed on the earlier replay: hand edits renamed what the code writes, not what the tests expect. The generators now rename both, and they pass.
- The pattern that prunes old daily logs matches Scient Agent's old logs, not Oh My Pi's: the logs directory is Scient's.
- Without a host-assigned root, the agent's own user config (commands, rules, MCP servers) is found where Oh My Pi finds it, `~/.scient-agent/agent` or a profile's, not under `SCIENT_AGENT_DIR`; under a host root it is the root's, as before. The broader rule changed behavior no host relies on, and failed Oh My Pi's test of that lookup whenever an earlier test had left `SCIENT_AGENT_DIR` set.
- The native loader no longer looks for an addon in `~/.local/share/scient-agent`. A compiled binary loads only the addon it embeds, so that candidate was never reached in a shipped build; a source checkout loads upstream's candidates.
- The natives folder no longer follows `SCIENT_AGENT_CONFIG_DIR`. Without a host root or `SCIENT_AGENT_NATIVES_DIR`, a compiled binary run with `SCIENT_AGENT_CONFIG_DIR=.custom` used to extract its addon under `~/.custom/natives`; it now extracts under `~/.scient-agent/natives`, as upstream's loader does with its own name. A host root and `SCIENT_AGENT_NATIVES_DIR` decide the folder as before.
- The startup update setting reads "Check for Scient Agent updates on startup", as the wording generator writes it; the check itself stays off.

Fixes that Oh My Pi itself needs, to propose upstream so their hooks can go: account sign-out refreshes every provider's catalog, not only the signed-out one (`SA-AUTH`, `logout.ts`); the native loader's own natives folder ignores the config folder override that `dirs.ts` honors.

#### Local checks

On Windows, against the separated replay:

| Check | Observed result |
|---|---|
| Divergence check in replay mode | Passed. 15 commits checked; each of the 3 generated commits matches its generator's output exactly. Footprint: 81 marker blocks, 194 lines, in 40 Oh My Pi files. |
| The checker's and generators' own cases (`bun test scripts/scient`) | 64 passed. |
| Identity and wording checks; `check:ts` (lint, format, types of every package) | Passed, with no lint warnings. |
| Scient's own tests (`test/scient/` in utils, natives, coding-agent and ai) | All passed. |
| Oh My Pi's `utils`, `natives`, `tui` and `ai` suites, against untouched 18.10.4 | `utils` and `natives`: no failure untouched 18.10.4 lacks. `tui`: the same five Windows failures as 18.10.4. `ai`: seven files that failed only on Scient's tree (User-Agent, gateway attribution, broker usage) pass now; the rest were timeouts that pass alone. |
| Oh My Pi's `coding-agent` suite (18,029 tests), against untouched 18.10.4 | Before the fixes below, 286 failed on Scient's tree and 239 on 18.10.4. Every test that failed only on Scient's tree was rerun file by file after them: each passes, or fails the same way on 18.10.4 (Windows symlinks, a git push that times out, timing). One was missed: the settings sidebar test, which assumes issue reports are on. Linux CI caught it. |

The comparison found what CI had never run: Scient had renamed things in code that Oh My Pi's tests still expected under the old names (log files, the desktop notifier, Hindsight banks, `local://` folders, the run-status record, completions, the updater's binaries), and three tests assert defaults `SA-SERVICES` changes on purpose. The generators now rename both sides, those three tests change in marked `SA-SERVICES` blocks, the user-config hook only applies under a host root, and the identity generator leaves alone the SSH control-path test, whose example paths are measured byte by byte. Oh My Pi's TypeScript tests now run in CI on Linux, as upstream's CI ran them.

That CI's first run found what Windows cannot run. Several Linux and macOS tests still expected Oh My Pi's folder and executable names: XDG data and cache folders, the shell-snapshot folder, the extension cache and a build-service update. Mnemopi's request test expected Oh My Pi's User-Agent, homepage and title. The generators now rename these too. Mnemopi's User-Agent expectation changes in a marked `SA-PRODUCT` block, because the version it reports is Scient's on purpose. The settings sidebar test turns issue reports on before it starts, in a marked `SA-SERVICES` block.

Review then found four tests that passed but had stopped testing what they meant to. Three report-bundle tests created `XDG_STATE_HOME/omp`, so on Linux and macOS they fell back to the real `~/.scient-agent` and wrote their logs there. A descriptor test looked for a leaked `omp.<day>.<pid>.log`, a name no log has anymore. Both now follow the generators, and so do the comments and docs that name log files.
An independent review of the replay, contract by contract against upstream's 18.9 and 18.10 changes, found one defect and four smaller issues. All were fixed:

- Marker lines had been placed inside the macOS callback application's `Info.plist` template, a Rust raw string, and would have been written into the plist. The application's name there is wording, so the wording generator now writes it, and no hand-written change remains in the template.
- The wording generator had renamed a pattern that matches a worker's `omp … listening on` readiness line. Patterns that match those lines now keep their spelling, as the lines do.
- The MLX title worker's launch tag now carries the product version, like the other shared workers.
- Upstream's release-script tests now pass: their asset-name checks use Scient Agent's names. (Since the separation below, the build id is stamped outside Oh My Pi's build scripts, and the compile probes are as upstream wrote them.)
- The test that every upstream custom sign-in hook is classified now reads the catalog's compiled hooks rather than the rule files' text.

A second review of the fixed replay found three more issues. All were fixed:

- The wording generator had renamed the message that marks a turn whose process died. Restore finds that record by its exact text, so a session carried over from a stock `omp` could not be restored. The message keeps upstream's spelling, so either agent's sessions restore in the other.
- Oh My Pi's Nix packaging still installed `dist/omp`, wrote settings to `~/.omp` and exported `OMP_*` variables, which Scient Agent ignores. Scient does not publish a Nix package, so the packaging is removed under `SA-RELEASE`. Upstream's `gen:nix` script, a comment and one sentence in `docs/local-models.md` still mention it.
- A session-archive error had renamed the manifest field it asks for. It names `omp`, the field's real name, again.

Not run yet:

- Rust checks and tests.
- The compiled isolation and capability checks.
- Desktop qualification against an 18.10.4 binary.
- The six-platform CI, which runs on the alignment pull request.

### Third alignment intake — 2026-10-17

This is a **replay built and checked locally, not a merged, tagged or published alignment**:

- Accepted source baseline: OMP `18.10.4`, `687892d1046ecaf18829b45f5b86928a308258f4`, from [PR #24](https://github.com/ScientFactory/scient-agent/pull/24) (`main` `3634cdb818`, tag `omp-sync/v18.10.4`).
- Target: OMP `18.11.3`, `96894a6147d8cc64b7e00ad3a7d7178fd93b9531`, under `refs/upstream-tags/v18.11.3`: 1,290 upstream commits after 18.10.4, changing 910 files. Product version stays `0.1.1`, which is not released yet.
- Inventory: the 15 commits of the 18.10.4 replay. Nothing was committed to `main` after its import.
- Integration: [PR #25](https://github.com/ScientFactory/scient-agent/pull/25). Its sync commit's tree equals the replay's, on `origin/replay/omp-v18.11.3`.

This is the first alignment after the separation, and it was measured:

- **Replay.** The generators applied; identity regenerated with no stale rule; all 11 contract commits applied without a conflict; wording regenerated with no stale text; the RPC clients regenerated. Upstream changed 7 of the 40 Oh My Pi files that carry Scient's hooks, with one to three commits each.
- **Time.** About seven minutes from a fresh worktree (`bun install` took one minute) to the assembled replay, timed on this Windows machine. Most of it was the identity generator. Reviewing upstream's range took longer than the replay did.
- **Against the old shape.** The pre-separation replay (`b7070614a2`) and the separated one were each replayed onto 18.11.3 the same way, in scratch worktrees:
  - each non-generated commit was cherry-picked, taking the commit's side of any conflict;
  - each generated commit was replaced by its generator's output.

  The pre-separation replay conflicted in two commits, in the root `README.md` and the native loader, one hunk each. The separated replay conflicted in none. Neither generator found a stale rule, but only the separated identity generator checks for one. This upstream range seldom touched Scient's seams, so the difference is real but small.
- **Footprint.** 82 marker blocks, 196 lines, in 41 Oh My Pi files. The 18.10.4 replay had 81, 194 and 40. The difference is one hook into upstream's new native fallback test (below).

A clean replay is not a reviewed one. Reviewing upstream's range for Scient's seams found:

| Seam | Incoming change and what Scient does |
|---|---|
| Native addon cache | 18.11 extracts only the selected addon. A modern addon that fails to load now falls back to the baseline one. `SA-NATIVE-CACHE` emptied a compiled binary's candidates, which already suppressed that fallback in 18.10.4. `withBuildCache` now keeps upstream's candidates inside the build's own folder, so the fallback works and never reaches an addon outside the build. The change is in Scient's file. Upstream's new test of this fallback compiles a probe binary and reads the version's folder. A marked `SA-NATIVE-CACHE` line points it at the build's folder inside it, and the test passes, which the old empty candidate list would not. |
| Browser uploads (new) | Upload staging folders in the temporary directory are swept once their process is gone. They are `scient-agent-uploads-*` now (an identity rule), so the two products never sweep each other's. |
| Auth gateway clients (new) | `auth-gateway serve --clients=<file>` admits scoped client tokens. The help's example file is `/etc/scient-agent/gateway-clients.json` (an identity rule), not Oh My Pi's. |
| Session build stamps (new) | Session files record the upstream package version and, from a source checkout, its commit. This is inherited as is. Recording Scient's product version and build id instead would be a new `SA-PRODUCT` hook, left for a deliberate decision. |
| Sign-ins | SambaNova (new) is a key sign-in. Scient's test that fails on an unclassified sign-in passes. |

Left as upstream wrote them: `OMP_BUILD_LABEL`, a cosmetic label like `OMP_LOG_LEVEL`; new temporary folder prefixes in tests; Tern view roles.

The three `KNOWN_FAILURES` recorded for 18.10.4's commit lapsed with this alignment. Linux CI then failed two of Oh My Pi's buckets:
- `native`: upstream's new native fallback test, fixed with the hook above.
- `coding-agent-native`: two browser tests.

The `coding-agent-native` bucket was then run on untouched 18.11.3 and on Scient's replay. Each tree was run as CI runs it, on the same runner type with natives built the same way, and a test counts if it failed in a run. The Scient runs include every CI run of this PR up to sync commit `78836421ce`:

| Test | Untouched 18.11.3 | Scient's replay |
|---|---|---|
| "cancels an inline worker's run whose renderer crashed …" | 4 of 10 | 11 of 14 |
| "does not rerun a call detached before its code started …" (relay) | 3 of 10 | 10 of 14 |
| "closes a reattached headless tab's page when the tab is released" | 1 of 10 | 0 of 14 |
| "re-reads an archive rewritten in place …" | 1 of 10 | 3 of 14 |

Each fails on untouched 18.11.3, so each is listed for 18.11.3's commit. Scient's rates for the two browser tests were higher (one-sided Fisher p ≈ 0.07 and 0.06). One difference between the trees was known: Scient's own test files put 950 files in this bucket against 946. That moves every chunk boundary after them, and so which chunks run side by side.

The difference was settled by running both trees on identical chunks. With `packages/coding-agent/test/scient` removed in the probe, both trees printed the same 95-chunk plan (the plan's SHA-256 matched). Each tree then ran the bucket 8 times:

| Test | Untouched 18.11.3 | Scient's replay |
|---|---|---|
| "cancels an inline worker's run …" | 7 of 8 | 7 of 8 |
| "does not rerun a call detached …" (relay) | 3 of 8 | 2 of 8 |

The rates match, so the earlier difference came from how the chunks fell, not from Scient's code, whose changes in these files only reword messages. A crash test that failed 7 times in 8 on untouched upstream is upstream's to fix.

Observed failures of the two browser tests all came in four-way bucket runs. In 20 runs of each test's chunk alone, on both trees and with both chunkings, the probe saw no failure of either test. That probe recorded only whether each target failed, so it shows less than it might.

In the identical-chunk runs, other tests failed once each. `interactive-terminal-e2e` and `browser-nav-frames-dialogs` failed on untouched upstream only, and `browser-open-options` on both trees. `bash-job-lifecycle` (a 3-second signal watchdog, in a file Scient does not change) and a setup hook in `tools/gh.test.ts` (renames only; on a runner that ran about 60% slower than the others) failed on Scient's tree only, once each. None of these is listed. A listed entry needs a failure seen on untouched upstream, and these occurred too rarely to justify it.

#### Local checks

On Windows, against the replay:

| Check | Observed result |
|---|---|
| Identity and wording checks (`--check`) | Passed. |
| The checker's and generators' own cases (`bun test scripts/scient`) | Passed. |
| `check:ts`: lint, format and types of every package | Passed, with no lint warnings. |
| Divergence check in replay mode | Passed. 15 commits checked; each of the 3 generated commits matches its generator's output exactly. Footprint: 82 marker blocks, 196 lines, in 41 Oh My Pi files. |
| Scient's own tests (`test/scient/` in utils, natives, coding-agent and ai) | All passed. Rust cannot be built on this machine, so they ran against the 18.10.4 Windows addon. Scient's tests use none of 18.11's new native functions. |

Not run locally: Rust checks and tests, the isolation check, and Oh My Pi's suites. CI builds and checks the six platforms, runs the isolation check on each, and runs Oh My Pi's TypeScript suite on Linux.

#### Compiled qualification

Against PR #25's CI build for Windows x64:
- binary sha256 `03b26e0929…`;
- `--runtime-info` reports product `scient-agent`, version `0.1.1`, upstream `oh-my-pi` 18.11.3 `96894a6147`, RPC protocols 1 and 2.

The previous binary was the published v0.1.0 for Windows x64.

| Check | Observed result |
|---|---|
| `capability-check.ts`, candidate after v0.1.0 | Passed every case: the v0.1.0 session resumed and continued, the pre-upgrade snapshot rolled back, the native Skill's text arrived, JavaScript eval computed 42, the shell artifact was written, and two overlapping children completed. |
| The same check, v0.1.0 as both binaries | Passed. |
| Scient Desktop's Scient Agent live suite (`ScientAgent.live.test.ts`, Desktop `origin/main` `5c94afd238`, with a stock `omp` 18.11.3 beside it; no model turn) | Candidate and v0.1.0 gave identical results: 2 passed (sign-in listing and flow; each product refuses the other's executable), 5 failed the same assertions, and the model turn was skipped (no model was configured). The failures: the provider status reads `warning`; a `.bun` folder appears in the test's home, outside the assigned root; the stock `omp` RPC process exits on start, so the coexistence and load cases do not finish. No failure is specific to the candidate. Their causes are not confirmed, and a defect shared with v0.1.0 would look the same. |

The capability check had last passed for v0.1.0. Its first run against 18.11.3 failed in the native phase. Since 18.10 a subagent has no `yield` tool and returns its final answer instead, and the check had recognised a subagent by that tool. It now recognises one by the assignment in its first message, and uses `yield` only where a subagent offers it. The check passes against both v0.1.0 and the candidate. Its first runs were on a heavily loaded machine, where the JavaScript worker missed its 5-second timeout. Without that load it passed every time.

Desktop takes a release only after its own catalog qualification. On six platforms that qualification checks `--runtime-info`, the RPC v2 handshake and `get_state`. Desktop accepts any Scient Agent 0.x built on Oh My Pi 18.x (18.2.8 or later) that offers RPC v2, so 0.1.1 needs no Desktop change.

That catalog check covers identity, not behavior. The Desktop qualification under "Qualification and rollback" is not yet complete for 0.1.1. It still needs a real turn, cancellation, background completion, coexistence with a stock `omp`, and a managed installation, plus an explanation of the five failures above.

### Fourth alignment intake — 2026-10-18

Scient Agent 0.1.1 was not released on 18.11.3. Oh My Pi published 18.12.0 and 18.12.1 while it was being qualified, so 0.1.1 ships on 18.12.1 instead.

- Accepted source baseline: OMP `18.11.3`, `96894a6147d8cc64b7e00ad3a7d7178fd93b9531`, from [PR #25](https://github.com/ScientFactory/scient-agent/pull/25) (tag `omp-sync/v18.11.3`).
- Target: OMP `18.12.1`, `291e055836c210f314af3f73f53244e8e9d09de8`, under `refs/upstream-tags/v18.12.1`. That is 228 upstream commits after 18.11.3, changing 438 files.
- Inventory: the 15 commits of the 18.11.3 replay, plus the two commits merged to `main` after its import ([PR #26](https://github.com/ScientFactory/scient-agent/pull/26): the capability check's subagent fix and its receipt). Both were folded into `SA-RELEASE`.
- Integration: [PR #27](https://github.com/ScientFactory/scient-agent/pull/27). Its sync commit's tree equals the replay's, on `origin/replay/omp-v18.12.1`.

The replay:
- **Generators.** Identity regenerated with no stale rule (552 files), and wording with no stale text (423 files).
- **Contract commits.** All 11 applied without a conflict.
- **Time.** 4.5 minutes, after a 77-second `bun install`.
- **Hooked files.** Upstream changed 4 of the 41 Oh My Pi files that carry Scient's hooks. Each hook still does what its contract says.
- **Footprint.** Unchanged: 82 marker blocks, 196 lines, in 41 files.

The replay was first assembled from the `omp-sync/v18.11.3` tag alone. That would have reverted PR #26 when imported, because PR #26 landed on `main` after the tag. The first compiled capability-check run caught it: it was still running the old check. "Replay and import" now lists the files an import changes beyond upstream's range before the PR opens.

Reviewing upstream's range for Scient's seams found nothing to adapt. Inherited as is:

| Change | Why Scient inherits it |
|---|---|
| `PI_REQUEST_COMPRESSION` replaces `PI_CODEX_ZSTD` | A behavior toggle, not a state selector. Scient renames only selectors. |
| Connection warm-up | A credential-less `HEAD` to the selected model's own endpoint, throttled per host. It never probes custom providers, gateways or local servers, and never contacts an Oh My Pi service. |
| `ThinkingContent.narration` on the RPC wire | Additive; the protocol stays v2. Desktop's tolerant decoder ignores it and shows such blocks as thinking, as before. |
| Eval `display()` removed; advisor concerns continue a finished run by default | Agent behavior, inherited like the rest of the agent loop. |
| Tern roles `omp.advisor.*`, `omp.tool.eval.*` | Left as upstream wrote them, like the other Tern roles. |
| SSH `ControlPath` from `~/.ssh/config` | Oh My Pi's own sockets stay under `getSshControlDir()`, which `SA-ROOT` places under Scient's root. |

**Known failures.** The 18.11.3 entries lapsed. Oh My Pi's six buckets were then run untouched on 18.12.1, on Scient's runner type and concurrency: `coding-agent-native` 6 times, `coding-agent-runtime` and `coding-agent-ui` 3 times each, the others twice. Five tests failed:

| Test | Untouched 18.12.1 | Scient, first CI run |
|---|---|---|
| "cancels an inline worker's run whose renderer crashed …" | 5 of 6 | failed |
| "does not rerun a call detached before its code started …" (relay) | 2 of 6 | passed |
| "re-reads an archive rewritten in place …" | 2 of 6 | failed |
| "keeps firing #onBranchChange across consecutive branch switches" | 1 of 6 (30 s timeout) | passed |
| "renders parent lineage with bash-style tree connectors" (agent hub) | 1 of 3 (`coding-agent-ui`) | passed |

Each is listed for 18.12.1's commit. The status-line test had also failed once on Scient's CI for 18.11.3. "closes a reattached headless tab's page" did not fail in those six runs, so it was dropped. Scient's first CI run failed only in listed tests.

The `v0.1.1` tag's CI run (39137517773) then failed in that dropped test. Rerunning the failed job passed, and the release was drafted from that run. The `coding-agent-native` bucket was then run 10 more times on untouched 18.12.1:

| Test | Untouched, 10 more runs | Untouched, all 16 |
|---|---|---|
| "cancels an inline worker's run whose renderer crashed …" | 8 | 13 |
| "does not rerun a call detached before its code started …" (relay) | 3 | 5 |
| "re-reads an archive rewritten in place …" | 3 | 5 |
| "closes a reattached headless tab's page when the tab is released" | 2 | 2 |
| "does not call a cancelled run's page listeners for the requests the cancel stops" | 1 | 1 |
| "keeps firing #onBranchChange across consecutive branch switches" | 0 | 1 |

The two tests failing in this probe, and not listed, are now listed: the headless-tab test, and a browser cancellation test that hit its 30-second timeout. Six runs were too few to judge a test that fails about one time in eight.

**Release.** `v0.1.1` was published from that run's draft, which held all six executables, each with its `.sha256`. Before publishing, the released Windows x64 executable was checked separately from the PR build qualified above:
- its SHA-256 (`3238a3f187…`) matches its checksum file;
- `--runtime-info` reports 0.1.1 on Oh My Pi 18.12.1, build id `0aff6a650899` (the `main` commit);
- `capability-check.ts`, run after v0.1.0, passed every case.

#### Local checks

On Windows, against the replay: identity and wording `--check`; the checker's and generators' own cases (64); `check:ts` (its one lint warning is in an upstream test, `packages/ai/test/anthropic-signature.test.ts`); the divergence check in replay mode; and Scient's own tests in utils, natives, coding-agent and ai, run against the 18.11.3 Windows addon. All passed. Not run locally: Rust, the isolation check and Oh My Pi's suites, which CI runs.

#### Compiled qualification

Against PR #27's CI build for Windows x64:
- binary sha256 `5c383c65b5…`;
- `--runtime-info` reports product `scient-agent`, version `0.1.1`, upstream `oh-my-pi` 18.12.1 `291e055836`, RPC protocols 1 and 2.

The previous binary was the published v0.1.0 for Windows x64.

| Check | Observed result |
|---|---|
| `capability-check.ts`, candidate after v0.1.0 | Passed every case: the v0.1.0 session resumed and continued, the snapshot rolled back, the native Skill's text arrived, eval computed 42, the shell artifact was written, two overlapping children completed. |
| The same check, v0.1.0 as both binaries | Passed. |

Desktop was qualified at `origin/main` `172f8a8099`, plus [Desktop PR #583](https://github.com/ScientFactory/scient-desktop/pull/583), which changes only tests. Coexistence ran beside a stock `omp` 18.12.1. Every Scient Agent and Oh My Pi live suite was run against the candidate. The same suites were run on 18.11.3's build the day before, and each failure there was rerun against v0.1.0.

Desktop PR #583 fixes two test bugs:
- **Subagent detection.** Desktop's subagent cases first failed against the candidate and passed against v0.1.0; stock `omp` 18.11.3 failed them the same way. The test recognised a subagent by its `yield` tool, which subagents lost in 18.10. That is the same bug PR #26 fixed in the capability check.
- **Real-turn cleanup.** The real-turn tests deleted their root before their scope closed, so closing it failed with `NotFound` on the session's backlog folder, on both builds, after every check had passed.

**Model turns.** With a small local model the real turns did not test the agent:
- With `ollama/qwen2.5:3b` the candidate's final answer was a tool call written out as text, for a file nobody asked for. On v0.1.0 the turn timed out.
- With `qwen3:4b` the first answer had not arrived after ten minutes.
- Ollama ran on CPU with its default 4,096-token context (seen for `qwen3:4b`). The agent's first request to a scripted model was 29 KB, so the prompt may not have fit. That explanation is suspected, not shown: no token count or truncation was measured for either Qwen run.

The model was then replaced with a scripted local stand-in on Ollama's port: it writes `answer.txt` with `42`, then replies with the requested text. On both builds:
- `OmpRealSmoke`'s real turn and resume pass.
- `ScientAgent.live.test.ts`'s real turn passes: the exact answer, only `answer.txt` in the project, resume, and Oh My Pi refusing to resume it. It passes when its home check also ignores `.bun` (below); that run's edit was local and not committed.

A hosted model's judgement was not exercised.

| Area | Candidate |
|---|---|
| Passed | Sign-in listing and flow; identity refusal both ways; the Scient extension, its essential tools and awareness; a subagent using Scient tools, and a wrong echoed result rejected; shell and file inputs; Stop and process loss for foreground tools; background continuation and a message sent while a job waits; models; custom models (the refresh barrier, every API format, keys kept out of events); fork and images; MCP authority; a scripted real turn and its resume, in both real-turn suites. |
| Failed, and the same on v0.1.0 | A `.bun` folder in the agent's home, outside the assigned root. This is Bun's runtime transpiler cache, written when the agent loads a large `--extension`; stock `omp` writes it too. Desktop should point `BUN_RUNTIME_TRANSPILER_CACHE_PATH` into the agent's root. Also failed: Stop on a waiting native job (Desktop's stub throws `Unimplemented method "stopDelegatedTasks"`), and the history count in fork continuity's context handoff, before its restart is reached. |
| Failed because of the Windows test setup | The load case (`pgrep`) and the shell-credentials case (`ps -E`); two custom-model cases that need `gemma4:12b-it-qat`, which this machine cannot run. |

No candidate-specific regression was found. Fork continuity across a process restart is not covered by this run, because the test fails earlier on both builds. A managed installation through Desktop's catalog follows publication: its automation qualifies `--runtime-info`, the RPC v2 handshake and `get_state` on six platforms.

### Fifth alignment intake — 2026-10-24

Scient Agent 0.1.2 ships on Oh My Pi 18.12.6.

- Accepted source baseline: OMP `18.12.1`, `291e055836c210f314af3f73f53244e8e9d09de8`, from [PR #27](https://github.com/ScientFactory/scient-agent/pull/27) (tag `omp-sync/v18.12.1`).
- Target: OMP `18.12.6`, `45c35e40c46166dc726ccc52f5d27f40f2449f99`, under `refs/upstream-tags/v18.12.6`. That is 1,557 upstream commits after 18.12.1, changing 907 files. Product version `0.1.2`.
- Inventory: the 15 commits of the 18.12.1 replay, plus the two commits merged to `main` after its import (`28334f2f82`, `0de3efb908`: the failures the v0.1.1 tag run exposed, and the release checks). Both were folded into `SA-RELEASE`.
- Integration: [PR #29](https://github.com/ScientFactory/scient-agent/pull/29). Its sync commit's tree equals the replay's, on `origin/replay/omp-v18.12.6`.

The replay:
- **Generators.** Identity regenerated with no stale rule (563 files), and wording with no stale text (436 files).
- **Contract commits.** Three of the 11 stopped on a conflict:
  - `SA-RELEASE` deletes upstream's CI workflow, which upstream changed. It stays deleted.
  - `SA-PRODUCT` (`dirs.ts`) and `SA-ROOT` (`env.ts`) each import beside a line where upstream added an import (`isBunTestRuntime`). Each hook now follows upstream's import.
- **Hooked files.** Upstream changed 12 of the 41 Oh My Pi files that carry Scient's hooks. Each hook still does what its contract says.
- **Footprint.** Unchanged: 82 marker blocks, 196 lines, in 41 files.

**Two defects, both mine, both fixed.**
- The first replay's generated commits were made with Homebrew's stable `rustfmt`, because the pinned nightly had no `rustfmt` component on the Mac that built it. Stable `rustfmt` ignores `rustfmt.toml`'s alignment options, so 16 Rust files the generators touch came out formatted unlike `main`. The local divergence check accepted them, because it regenerated with the same `rustfmt`. The list of files an import changes beyond upstream's range exposed it. The generators were rerun with the pinned toolchain first on `PATH`, and "Build" now says the generators need it.
- Scient's host-root test failed on Linux CI and passed locally. From 18.12.6, `getLogsDir()` answers a temp folder in any process marked `PI_TEST_RUNTIME`, and Oh My Pi's test runner marks the processes it starts. The test's child stands for the agent, so it no longer inherits the marker. Scient's suites now also pass locally with the marker set.

Reviewing upstream's range for Scient's seams found nothing to adapt. Inherited as is:

| Change | Why Scient inherits it |
|---|---|
| `OMP_AUTH_BROKER_ACCOUNT_POOL_FILE` (18.12.3) | A state selector. The existing `AUTH_BROKER_*` rule names it `SCIENT_AGENT_AUTH_BROKER_ACCOUNT_POOL_FILE`. |
| Approval cache `approval-cache.db`, approval mode `always-ask-cached` | Kept in the agent directory, which `SA-ROOT` places under Scient's root. |
| Test logs in `<tmpdir>/omp-test-logs-<uid>`, and the natives unit-test crash folder | Only test processes write there. The agent's own logs stay under its root. |
| Build variables `OMP_KEYMAP_DARWIN_HELPER`, `OMP_INPUT_RELEASE_HELPER`, `OMP_OAUTH_RELAY_BINARY` | They embed helper executables at build time; nothing reads them at run time. |
| `set_todos` saves a `user_todo_edit` entry; MCP progress on `tool_execution_update`; abort also cancels background built-in commands; `/mcp reauth` over RPC | Additive. The RPC wire schema has no upstream change, and the protocol stays v2. |
| A stopped run stays stopped (18.12.4): a background result no longer restarts it | Agent behavior, inherited like the rest of the agent loop. |
| Background job widgets (`async.widgets`, on by default) | Agent behavior. Over RPC a widget is written when the agent's own job tools read a running job: a model call, counted in the session's usage. Desktop draws no widgets; it can turn the setting off in the agent's config. |

**Known failures.** The 18.12.1 entries lapsed. Oh My Pi's six buckets were then run untouched on 18.12.6, on Scient's runner type and concurrency:
- `coding-agent-native` 8 times;
- `coding-agent-runtime` and `coding-agent-ui` 3 times each;
- the others twice.

Only `coding-agent-native` failed, in two tests:

| Test | Untouched 18.12.6 | Untouched 18.12.1 |
|---|---|---|
| "re-reads an archive rewritten in place …" | 4 of 8 | 5 of 16 |
| "does not rerun a call detached before its code started …" (relay) | 2 of 8 | 5 of 16 |

Both are listed for 18.12.6's commit. The other five 18.12.1 entries did not fail and were dropped.

A second probe then ran `coding-agent-native` 8 more times on untouched 18.12.6 and 8 times on Scient's replay, side by side:

| Test | Untouched, all 16 runs | Scient's replay, 8 runs |
|---|---|---|
| "re-reads an archive rewritten in place …" | 5 | 3 |
| "does not rerun a call detached before its code started …" (relay) | 4 | 6 |
| "hands the scope to a new broker after its runtime dir is deleted under it" | 1 | 0 |
| "imports cookies, round-trips storage, and restores a saved state in a fresh tab" | 1 | 0 |
| "libkitty end-to-end > replaces retired history after /shake …" | 0 | 1 |

The relay test fails the same way on both trees: the reattach race outlasts the call's one-second budget.

The libkitty test also failed in the CI run that the PR's final commit triggered on its branch. The PR run of the same tree passed. It never failed untouched: 16 bucket runs, plus 120 local runs of its file with six running at once. On Scient's tree locally it failed once in 30 such runs, then passed 144 more. Scient changes nothing it renders: its changes to the terminal interface are names. The check that failed follows a render wait with no condition.

It is not listed, because it has not been seen failing untouched. A release run that fails on it is rerun, as v0.1.1's was. The two untouched-only failures are not listed either; neither has failed on Scient's tree.

#### Local checks

On macOS (Apple silicon), against the replay, all passed:
- identity and wording `--check`;
- the checker's and generators' own cases (64);
- `check:ts`: two lint warnings, both in upstream tests;
- the divergence check in replay mode: 15 commits, each of the 3 generated commits matching its generator;
- Scient's own tests in utils (13), natives (8), coding-agent (34) and ai (1), with and without `PI_TEST_RUNTIME`.

The native addon and the executable were built with the pinned nightly and Bun 1.4.2. Not run locally: Rust checks and tests, and Oh My Pi's suites, which CI runs.

#### Compiled qualification

Against a local macOS arm64 build of the replay:
- SHA-256 `db2e5fbd51…`;
- `--runtime-info` reports product `scient-agent`, version `0.1.2`, upstream `oh-my-pi` 18.12.6 `45c35e40c4`, RPC protocols 1 and 2.

The previous binary was the published v0.1.1 for macOS arm64 (SHA-256 `d979b22d14…`, checked against its checksum file).

| Check | Observed result |
|---|---|
| Isolation check | Passed. Hosts contacted on startup: the model catalog and providers' public model lists, as before. |
| `capability-check.ts`, candidate after v0.1.1 | Passed every case: the v0.1.1 session resumed and continued, the snapshot rolled back, the native Skill's text arrived, eval computed 42, the shell artifact was written, two overlapping children completed. |
| The same check, v0.1.1 as both binaries | Passed. |
| Scient Desktop's live suites against the candidate and v0.1.1, both on this machine | Identical on both: 23 passed, 8 failed, 2 skipped. |

The live-suite runs used Desktop `origin/main` `57277d459b` plus [Desktop PR #650](https://github.com/ScientFactory/scient-desktop/pull/650), which requests delta-only message updates. Every Oh My Pi suite ran with `OMP_QUALIFY_TARGET=scient`, and `ScientAgent.live.test.ts` ran beside the stock `omp` installed here (18.3.1). No model turn was run.

The eight failures:
- Two custom-model cases need `gemma4:12b-it-qat`, which this machine's Ollama lacks.
- Coexistence and load fail because the stock `omp` 18.3.1 session does not open.
- Two provider-status checks read `warning`: the test home has no sign-in.
- Stop on a waiting native job times out, and fork continuity's history count fails before its restart. These two are recorded for v0.1.0 under the fourth intake.

No candidate-specific regression was found.

### Sixth alignment intake — 2026-10-26

Scient Agent 0.1.3 is aligned with Oh My Pi 18.13.0 ([PR #32](https://github.com/ScientFactory/scient-agent/pull/32)).

- Frozen owned `main`: `9b075be95c99c25b5ee99f71bd20ce97f1fe3699`.
- Accepted source baseline: OMP `18.12.6`, `45c35e40c46166dc726ccc52f5d27f40f2449f99`, from [PR #29](https://github.com/ScientFactory/scient-agent/pull/29), tag `omp-sync/v18.12.6`.
- Target: OMP `18.13.0`, `011ab732fa2d8657203d17f6af80d57809eb24f4`, under `refs/upstream-tags/v18.13.0`: 603 upstream commits, changing 770 files. Product version `0.1.3`.
- Inventory: the 15 commits of the accepted replay, replacing all three generated commits, and all three commits after `929589c84500` on `main`. The probe record (`40aed12f7b`) is folded into `SA-RELEASE`; the spool cap (`6d0b65d4bf`) and discovery sources (`9b075be95c`) remain their own contract commits. Discovery also retains its `SA-ROOT` dotenv regression coverage.
- Replay: `replay/omp-v18.13.0`, 17 commits: generators, identity, 13 contracts in ledger order, wording and RPC clients. Integration imports that replay's exact tree onto frozen `origin/main` as `sync: Oh My Pi 18.13.0`.

| Step | Result |
|---|---|
| Identity generator | No stale rule; 569 files renamed. Repo-pinned `nightly-2026-10-06` rustfmt first on PATH. |
| Contract commits | Only `SA-RELEASE` conflicted: upstream changed `ci.yml`, `flake.lock` and `flake.nix`; all three retain Scient's registered deletions. All other contracts replayed without conflicts. |
| Wording generator | No stale text; 443 files rewritten. |
| RPC generator | Regenerated the schema and TypeScript, Python, Rust and Go clients. |
| Hooked files upstream changed | 12 of 45; reviewed against every ledger contract. |
| Footprint | Unchanged from frozen `main`: 90 marker blocks, 210 lines, in 45 files. The accepted 18.12.6 replay had 82/196/41; the difference is the already merged spool and discovery contracts. |

No contract hook needed adapting, and no new tests were added. Inherited as is:

| Seam | Incoming change and disposition |
|---|---|
| Identity, root and native cache | No new state selector or home folder requiring a rule. Relay extension installation/self-update uses `getBrowserRelayDir()/extension`, under the existing root. Python scans all PATH candidates after the existing managed Python folder. Native loader/cache and root hooks are unchanged. |
| Services | Marketplace refresh moves until after session setup, still honoring Scient's default `off`. Self-update guard and default-off issue reporting remain. The relay updates its installed extension from bundled assets, not a network updater. |
| Startup/provider network | llama.cpp discovery gains fallback loopback port 9931 after 8080; `LLAMA_CPP_BASE_URL` still selects one endpoint. Cursor account/plan requests, Xiaomi regional validation and Antigravity request headers/scopes remain provider behavior. `PI_ANTHROPIC_API_VERSION` is tuning, not a state selector. No new automatic OMP reporting or release fetch was found. |
| Discovery | The capability registry seam and `SCIENT_AGENT_ENABLE_SOURCES` union are unchanged. Skill slash commands gain `side` metadata; `--no-context-files` can suppress context discovery. Skill-description compression changes model-role selection while keeping its existing cache under the root. |
| Auth and RPC startup | Model registry adds discovery fallbacks/cache namespace changes and account project IDs. Sign-in revalidation, broker ownership, logout and model-less startup hooks remain valid. |
| Spool | `rpc-output.ts` is unchanged upstream. Scient's byte cap and dead-process cleanup replay intact. |
| Product, worker, brand, policy, build and release | Product CLI gains upstream flags/Windows console-title handling around the existing runtime-info hook. Worker, symbol, policy and stable-expression hooks are unchanged. Updated upstream CI/Nix files remain deleted; no upstream publication workflow is activated. |

**RPC changes for Desktop.** Protocol versions stay 1 and 2; no command or frame type is added or removed. The complete wire-definition delta is:
- `prompt_result.error.code?: "cost_cap"`: non-retryable refusal when `session.maxCost`/`--max-cost` is reached. The process stays alive, and later prompts fail until the cap is raised. It can settle without a model run; Desktop must accept the terminal error without waiting for an `agent_start`.
- `SessionStats.editRejections?: Record<string, number>` in `get_session_stats`.
- `BtwHistoryRecord.images?` and `BtwHistoryTurn.images?`: image content arrays in `btw`, `get_btw_history` and `btw_record` snapshots. The new TUI-only topic `title` is explicitly stripped from RPC.

Existing notice events can carry source `cost-gate` (warning/error). Open-ended transcript/tool payloads also gain custom message type `rewind-report` and edit failure `details.errorKind` (the source for edit-rejection counts). Skill prompt rendering/currentness handling changes internally without a command-shape change. `dumpTools` still lists top-level tools only; upstream's new documentation explains that MCP devices can instead be mounted under `xd://`, not new RPC commands. These are inherited runtime capabilities, not a claim of Desktop UI support or live Desktop qualification.

**Known failures.** The 18.12.6 entries lapsed. The PR's first CI run passed every bucket except `coding-agent-native`, which failed only the archive re-read test. A probe then ran `coding-agent-native` 8 times on untouched 18.13.0 and 8 times on Scient's replay, side by side, on Scient's runner type and concurrency. Untouched 18.13.0 failed 7 of its 8 runs; Scient's replay failed 4 of 8. Six tests failed untouched, and all six are listed for 18.13.0's commit:

| Test | Untouched 18.13.0 | Scient's replay |
|---|---|---|
| "re-reads an archive rewritten in place …" | 4 of 8 | 1 of 8 |
| "does not rerun a call detached before its code started …" (relay) | 3 of 8 | 1 of 8 |
| "accepts an untrusted certificate for the tab's lifetime …" | 2 of 8 | 3 of 8 |
| "opens a default tab in the browser of the tab … used last …" | 1 of 8 | 0 of 8 |
| "paints each requested image-only page …" (PDF screenshots) | 1 of 8 | 0 of 8 |
| "puppeteer's own request subscriptions unsubscribe during a run" | 1 of 8 | 0 of 8 |

Two tests failed once each, on Scient's replay only, and are not listed: the libkitty "/shake" end-to-end test (which also failed only on Scient's tree at 18.12.6) and "allows a cancelled bash job to run its TERM cleanup". Neither touches a Scient hook; one failure in eight is within the noise the untouched runs show.

#### Local checks

On macOS arm64 with Bun 1.4.2 and the repo-pinned October nightly:
- Identity and wording `--check`, all 64 script tests and `check:ts` pass (seven lint warnings in three upstream test files).
- Replay-mode divergence verification passes: 17 commits, all three generated commits equal their generators, footprint 90/210/45.
- Scient suites pass both with and without `PI_TEST_RUNTIME`: utils 15, natives 8, coding-agent 48, ai 1. Controllers use disposable homes.
- Affected upstream RPC/cost/stats suites pass: 82 cases across six files (`rpc-prompt-result`, `rpc-btw`, `rpc-skill-command`, `rpc-mcp-discovery`, `cost-gate`, `agent-session-stats`).
- Native addon and compiled macOS arm64 executable build; `--runtime-info` reports Scient Agent 0.1.3, OMP 18.13.0 at the full pin above, RPC `[1,2]`, build ID `source`. Compiled isolation passes.

Not run locally: Rust tests and hosted-model turns. CI builds and checks the six platforms and runs the six buckets.

### Seventh alignment intake — 2026-11-02

Scient Agent 0.1.4 is aligned with Oh My Pi 18.15.0.

- Frozen owned `main`: `9825e522bc2f6b48dd3159b0a72b77e72b1e82e7`.
- Accepted source baseline: OMP `18.13.0`, `011ab732fa2d8657203d17f6af80d57809eb24f4`, tag `omp-sync/v18.13.0`.
- Target: OMP `18.15.0`, `3fedf8d53267e32a6d7521ce725fdcc4a36fdc67`, under `refs/upstream-tags/v18.15.0`: 1,809 commits (1,314 without merges), changing 2,073 files. Product version `0.1.4`.
- Inventory: the 17 commits of the accepted replay, replacing all three generated commits. `main` has no commit after the `sync:` import.
- Replay: `replay/omp-v18.15.0`: generators, identity, 15 contracts in ledger order, wording and RPC clients.

| Step | Result |
|---|---|
| Identity generator | No stale rule; 590 files renamed. |
| Contract commits | Only `SA-RELEASE` conflicted: upstream changed `ci.yml`, `nix.yml`, `flake.lock`, `flake.nix` and `nix/package.nix`, which keep their deletions. Upstream's two new Nix files are added to that deletion. |
| Wording generator | No stale text; 454 files rewritten. It now also refreshes the export viewer's pin. |
| RPC generator | Regenerated the schema and TypeScript, Python, Rust and Go clients. |
| Hooked files upstream changed | 26 of 47; reviewed against every ledger contract. A separate review of the replay by Codex found no correctness problem. |
| Footprint | 98 marker blocks, 224 lines, in 49 files, from 90, 210 and 45. The growth is `SA-EXPORT`, `SA-HOST-PAGES` and the favicon hook. |

Changes beyond the replay:

| Change | Why |
|---|---|
| Bun 1.4.4 in `scient.yml` | Upstream's engine floor moved past the 1.4.2 the workflow pinned. |
| `OMP_TEST_TIMEOUT: "120"` in `upstream-tests` | Upstream's CI sets it and Scient's job did not, so tests ran under the 30-second default. `coding-agent-native` on untouched upstream went from failing 7 of 8 runs at 18.13.0 to 1 of 8 here. |
| New contract `SA-EXPORT` | Upstream's packaged HTML export loads its viewer from a CDN by checksum. Scient's rewritten wording changes the viewer's bytes, so `bun install` refused the stale pin and the file does not exist on that CDN. The binary embeds its viewer. |
| New contract `SA-HOST-PAGES` | `/stats` opened the system browser beside Scient Desktop. |
| `SA-BRAND` covers the dashboard's favicon | The dashboard's tab still carried Oh My Pi's mark. |
| Two wording rules | The generator had rewritten a URL scheme in `hyperlink.test.ts`, and had missed an escaped word in `cursor-system-prompt-history.test.ts`. Both failed every run on Scient's tree only; the probe caught them. |

**RPC changes for Desktop.** Protocol versions stay 1 and 2. New commands: `navigate_tree`, `abort_branch_summary`, `set_label`, `get_session_lease`, `dictation_start`, `dictation_stop`, `live_connect`. New frames: `manual_compaction_start`, `manual_compaction_end`, `dictation_state`, `dictation_transcript`, `dictation_end`. `message_update` deltas now carry the block or message a client needs to rebuild the stream. `extension_ui_request` `input` can carry `secret: true`. Desktop's matching change is a separate pull request; older hosts ignore all of this.

**Behavior that reaches users.** OpenAI live steering is off by default, so a steer on a GPT model waits for the next tool boundary. A `provider/model` name must match exactly. A subagent model the configuration does not allow is refused.

**Known failures.** The 18.13.0 entries lapsed. A probe (branch `probe/pristine-18150`) ran each bucket on untouched 18.15.0 and on Scient's replay side by side, on Scient's runner type, concurrency and per-test ceiling: `coding-agent-native` 8 times each, the other five twice each.

| Test | Untouched 18.15.0 | Scient's replay |
|---|---|---|
| "removes the workspace folders a session added …" (LSP mux) | 1 of 8 | 0 of 8 |
| "opens a default tab in the browser of the tab … used last …" | 0 of 8 | 1 of 8 |
| "raw predicate wait survives cross-origin document navigation …" | 0 of 8 | 1 of 8 |
| "hands the scope to a new broker after its runtime dir is deleted …" | 0 of 8 | 1 of 8 |
| "routes GET-listener progress during a pending POST …" | 0 of 8 | 1 of 8 |

Only the first is listed: the rule is that an entry fails on untouched upstream. The other four are single failures in tests no Scient hook touches, and a recurrence takes a rerun or a second probe. The relay test also failed untouched at 18.13.0.

#### Local checks

On macOS arm64 with Bun 1.4.4 and the repo-pinned October nightly:
- Identity and wording `--check`, script tests and `check:ts` pass.
- Replay-mode divergence verification passes: 19 commits, all three generated commits equal their generators.
- Scient suites pass: utils 946, natives 185, coding-agent 50, ai 1, scripts 64. Affected upstream RPC, session and model suites pass 296, with 14 skipped.
- Native addon and compiled macOS arm64 executable build; `--runtime-info` reports Scient Agent 0.1.4, OMP 18.15.0 at the full pin above, RPC `[1,2]`. Compiled isolation passes, and the hosts contacted on startup are the same as before.
- `capability-check.ts` against the v0.1.3 binary passes every case.
- A real `--export` from the compiled binary renders in headless Chrome, named Scient Agent.
- Scient Desktop's live suites against the candidate and v0.1.3: identical, 52 passed, 5 failed, 9 skipped. The five are recorded under earlier intakes or need a model this machine lacks.
- Real turns ran through Scient Desktop's candidate on GPT-6 Luna: questions, steering, Stop, Fast, Compact, subagents, background wake-up, images, edits, Python and resume after a restart.

Not run locally: Rust tests. CI builds and checks the six platforms and runs the six buckets.

### Eighth alignment intake — 2026-11-07

Scient Agent 0.1.4 is aligned with Oh My Pi 18.18.0. The 0.1.4 of the seventh intake (Oh My Pi 18.15.0) was never released, so the version stays the next one users receive.

- Frozen owned `main`: `dcd4a55a88eb0831a1a2fdf52ff56799a858af95`.
- Accepted source baseline: OMP `18.15.0`, `3fedf8d53267e32a6d7521ce725fdcc4a36fdc67`, tag `omp-sync/v18.15.0`.
- Target: OMP `18.18.0`, `b5a6b2f7e5b6606b6562e678ead83f21738f34a0`, under `refs/upstream-tags/v18.18.0`: 1,049 commits (817 without merges), changing 2,938 files. Product version `0.1.4`.
- Inventory: the 19 commits of the accepted replay, replacing all three generated commits. `main` has no commit after the `sync:` import.
- Replay: `replay/omp-v18.18.0`: generators, identity, 16 contracts in ledger order, wording and RPC clients.

| Step | Result |
|---|---|
| Identity generator | No stale rule; 598 files renamed. Two new rules rename the launcher a new updater test writes onto `PATH`. |
| Contract commits | `SA-RELEASE` conflicted as before on CI and Nix files that keep their deletions; upstream added none. `SA-PRODUCT` met upstream's new SQLite lock shim in `cli.ts`: `--runtime-info` returns before it, as `--help` and `--version` do. `SA-SERVICES` met the new auto-update in `main.ts`. |
| Wording generator | No stale text; 467 files rewritten. |
| RPC generator | Regenerated the schema and TypeScript, Python, Rust and Go clients. |
| Hooked files upstream changed | 29 of 56; reviewed against every ledger contract. A Codex review of the replay found one defect, fixed below. |
| Footprint | 109 marker blocks, 237 lines, in 56 files, from 98, 224 and 49. |

Changes beyond the replay:

| Change | Why |
|---|---|
| `SA-SERVICES` covers the background auto-update | 18.17 added `update.auto`, offered by the setup wizard. It installs Oh My Pi releases. `canSelfUpdate()` now answers no, so the wizard never offers it and no launch starts its worker, and the worker's hidden entry point refuses to run (Codex found that it bypassed both guards). |
| `SA-AUTH` covers worker-thread subagents | 18.17 runs subagents in worker threads that reach the main thread's credential store through a bridge. `credentials.heldByBroker` crosses it like upstream's own properties. |
| New contract `SA-SHELL-TRACE` | 18.17 records each bash command's execution trace for the terminal's shell view: up to 8 MiB, polled every 80 ms, and every live frame carries the whole trace. Scient Desktop draws none of it. A ten-second loop saved a 3.5 MB trace for 625 bytes of output and kept Desktop's server above 100% CPU for the whole command; with the trace off, the session took 8 KB and the server stayed under 12%. `display.shellVisualization` defaults to off; a user can turn it on. |
| Sign-in classification test | 18.17 added three custom sign-ins (`devin-cli`, `devin-windsurf`, `mistral-vibe-sign-in`). None asks for a pasted key, so they are account sign-ins, as the classification already reported. |

**Reviewed and left as upstream.** Spotlight (`spotlight.experiment`) sends tool results to Stencil's service but is off by default and needs a Stencil credential, like `share` and `collab`. The tiny model and local speech now install their runtimes on first use, under the agent's root. Text verbosity now defaults to low, which shortens answers. No new variable chooses where state lives.

**RPC changes for Desktop.** Protocol versions stay 1 and 2. `bash` results report truncation (`elidedBytes`, `elidedLines`, `columnTruncated*`, `columnMax`) and, when asked, a `trace`. Nothing Desktop reads changed shape.

**Known failures.** The 18.15.0 entry lapsed. A probe (branch `probe/pristine-18180`) ran each bucket on untouched 18.18.0 and on Scient's replay side by side, on Scient's runner type, concurrency and per-test ceiling: `coding-agent-native` 8 times each, the other five twice each. Only `coding-agent-native` failed: 6 of 8 runs untouched, 4 of 8 on the replay. Every other bucket passed every run on both.

| Test | Untouched 18.18.0 | Scient's replay |
|---|---|---|
| 14 tests: browser relay, crashed-tab reattach, frozen tabs, PDF screenshots, input cut mid-gesture, Responses WebSocket recovery | 1 or 2 of 8 each | 0 or 1 of 8 each |
| "allows a cancelled bash job to run its TERM cleanup" | 0 of 8 | 1 of 8 |

The fourteen are listed in `upstream-tests.ts` with their counts. The last is a single failure in a test no Scient hook touches and is not listed; a recurrence takes a rerun or a second probe.

A second probe followed when the pull request's `workspace` job failed twice on "aborts a pipe holder after an earlier graceful stop finishes" (`packages/utils/test/ptree-signal.test.ts`, added upstream the day before 18.18.0). It ran `workspace` six times on each tree: the test failed once on untouched 18.18.0 and once on the replay, and is listed. The cause is in the test's fixture: the root shell reports readiness right after forking, before its descendant has run `trap "" TERM`, so the graceful stop's SIGTERM can end the descendant first and leave the later abort nothing to act on. Delaying that `trap` makes it fail every run. The fix belongs upstream; Scient's tree keeps the test as written.

#### Local checks

On macOS arm64 with Bun 1.4.4 and the repo-pinned October nightly:
- Identity and wording `--check`, script tests and `check:ts` pass.
- Replay-mode divergence verification passes: 20 commits, all three generated commits equal their generators.
- Scient suites pass: utils 951, natives 194, coding-agent 52, ai 1, scripts 64. Affected upstream RPC, session, model, auth, updater and setup-wizard suites pass 1,005, with 15 skipped; the bash, shell, trace and settings suites pass 614.
- Native addon and compiled macOS arm64 executable build; `--runtime-info` reports Scient Agent 0.1.4, OMP 18.18.0 at the full pin above, RPC `[1,2]`. Compiled isolation passes, and the hosts contacted on startup are the same as v0.1.3's.
- `capability-check.ts` against the v0.1.3 binary passes every case.
- A real `--export` from the compiled binary renders in headless Chrome, named Scient Agent, with its viewer embedded.
- Scient Desktop's live suites against the candidate and v0.1.3: identical, 66 passed, 5 failed, 9 skipped. The five fail on both and need a model this machine lacks or are recorded under earlier intakes.
- Real turns through a Scient Desktop dev app on `main` (`8d32bf8e12`) with GPT-6 Luna: bash with Hebrew, Chinese and accented text, a question through `ask`, a subagent running Python, Stop and continue, Compact, `/stats` opening in Scient's browser, and resume after a restart. One compaction, right after a stopped command, lost two earlier answers; a later fact survived compaction and restart. This compaction path is unchanged since before 18.15.0.

Not run locally: Rust tests. CI builds and checks the six platforms and runs the six buckets.

### Ninth alignment intake — 2026-11-10

Scient Agent 0.1.5 is aligned with Oh My Pi 18.18.6.

- Frozen owned `main`: `b131cb176ce747c1c008caaa41f4da10357f2a51`.
- Accepted source baseline: OMP `18.18.0`, `b5a6b2f7e5b6606b6562e678ead83f21738f34a0`, tag `omp-sync/v18.18.0`.
- Target: OMP `18.18.6`, `9058ab9d229663e229e2867824ba6df6f21e9e59`, under `refs/upstream-tags/v18.18.6`: 1,002 commits (737 without merges), changing 1,028 files. Product version `0.1.5`.
- Inventory: the 20 commits of the accepted replay, replacing all three generated commits, and the five commits on `main` after the `sync:` import, each folded into its contract: the release copy to `downloads.scientfactory.com`, OAuth email metadata for hosts and its regenerated clients, the zstd copy of each release binary, and the Intel Mac Rust cache.
- Replay: `replay/omp-v18.18.6`: generators, identity, 17 contracts in ledger order, wording and RPC clients.

| Step | Result |
|---|---|
| Identity generator | No stale rule and no new one; 609 files renamed. |
| Contract commits | `SA-RELEASE` conflicted as before on the CI and Nix files it deletes. `SA-ROOT` met upstream's new OpenTelemetry handling of `.env` values in `env.ts`. `SA-AUTH` met 18.18.2's sign-out, which now goes through the agent session; one Scient test changed with it. |
| Wording generator | No stale text; 474 files rewritten, with four new rules for the prompts (below). |
| RPC generator | Regenerated the schema and TypeScript, Python, Rust and Go clients, now with the form messages below. |
| Hooked files upstream changed | 20 of 56; reviewed against every ledger contract. |
| Footprint | 126 marker blocks, 300 lines, in 58 files, from 109, 237 and 56. |

Changes beyond the replay:

| Change | Why |
|---|---|
| New contract `SA-ASK-FORM` | 18.18.3 made `ask` send one HTML form. RPC has no form surface, so every RPC host, Scient Desktop included, would have been asked one field at a time instead of on the one question card it shows today. Desktops update the agent on their own, so the fallback ships with the agent: a host that sends `set_form_dialog` receives the whole form (`form` request, answered with the form's data); a host that only sends `set_ask_dialog` gets the form on its one card, with choices as options, text fields as free-text questions, the rest of the form in the question text, and a failing answer asked again. Hidden inputs are submitted as the form has them. Upstream's test that an opted-in host is still asked field by field changes with it, in marked blocks. |
| Prompts for researchers | Upstream's role, "trusted coding assistant", and three personality lines assumed a programmer. The role is now "Scient's trusted research and coding assistant", and each personality matches its explanations to the reader's expertise instead of assuming a technical reader. `rename-wording.ts` owns the four sentences and stops when upstream moves one. Everything else in 18.18.2's rewritten prompt comes in as written. |
| Toolchain | Upstream's Rust nightly moved from 2026-10-06 to 2026-11-08. The generated commits were made with that toolchain's `rustfmt` first on `PATH`. |

**RPC changes for Desktop.** Protocol versions stay 1 and 2. New: the `set_form_dialog` command, the `form` UI request and its response, all used only by a host that opts in. A host that does not opt in sees `ask` exactly as before.

**Known failures.** The 18.18.0 entries lapsed. A probe (branch `probe/pristine-18186`, run 42796894484) ran each bucket on untouched 18.18.6 and on Scient's replay, on Scient's runner type, concurrency and per-test ceiling: `coding-agent-native` 8 times each, the other five twice each. The probe's jobs report success whatever their tests do, so their logs were read test by test. Every bucket but `coding-agent-native` passed every run on both trees.

| Test | Untouched 18.18.6 | Scient's replay |
|---|---|---|
| "captures a targeted background tab without switching the user's visible tab" | 8 of 8 | 8 of 8 |
| 10 tests: crashed-tab reattach, closing an owned page, cancelled page listeners, Responses WebSocket recovery | 1 or 2 of 8 each | 0 of 8 each |
| "opens a default tab in the browser of the tab … used last" | 1 of 8 | 2 of 8 |
| The `ask` RPC test above, before it changed with `SA-ASK-FORM` | 0 of 8 | 8 of 8 |
| 2 tests: a click cut off mid-gesture, incomplete tool arguments over WebSocket | 0 of 8 | 1 of 8 each |

The twelve that failed untouched are listed in `upstream-tests.ts` with their counts. The `ask` test failed on every replay run because the contract changes what it checks; it now checks the contract. The last two failed once each in code no Scient hook touches and are not listed; a recurrence takes a rerun or a second probe. The first CI run of this alignment read the probe's jobs as passing and listed nothing; its `coding-agent-native` job failed on the `ask` test, the background-tab screenshot, and two tests the probe never saw fail ("closes a frozen tab directly", and a Responses WebSocket first-event timeout listed for 18.18.0).

#### Local checks

On macOS arm64 with Bun 1.4.4 and the repo-pinned November nightly:
- Identity and wording `--check`, the script tests (73) and `check:ts` pass; the ask fallback's tests pass (11).
- Replay-mode divergence verification passes: 21 commits, all three generated commits equal their generators.
- Compiled macOS arm64 executable: `--runtime-info` reports Scient Agent 0.1.5, OMP 18.18.6 at the full pin above, RPC `[1,2]`. Compiled isolation passes, the hosts contacted on startup are the same as v0.1.4's, and `capability-check.ts` passes every case.
- Scient Desktop's live suites against the candidate and v0.1.4: the same tests fail on both. They need a model in a fresh root, which this machine lacks (its Ollama has none), or fail on v0.1.4 the same way.
- Real turns through a Scient Desktop dev app on `main` with GPT-6 Luna: the role wording, bash with Hebrew, Chinese and accented text, a two-question `ask` form on one Desktop card with both answers received, a subagent running a paired t-test in Python (numbers checked independently), Stop and continue, Compact with earlier facts kept, `/stats` in Scient's browser, and resume after a restart. With GPT-6.1 Terra on `main` after Scient Desktop #822, a read-only computer-control call. The test found one defect, a text field's example shown as "For example: e.g. 0.05"; it was fixed and checked again in the app.

Not run locally: Rust tests. CI builds and checks the six platforms and runs the six buckets.

### Recurring cadence

Check upstream releases at least weekly and before each Scient Agent release; use a daily read-only digest if OMP's pace warrants it. Prepare one bounded release alignment at a time, with urgent security/compatibility fixes handled sooner. Monitoring reports movement; it never merges code or advances accepted pins. This repository currently has release/build CI, **not an automated upstream monitor**. The procedure above is manual until a separately implemented read-only monitor and accepted receipt/checkpoint format exist.

## Build

Needs Bun 1.4.4 or newer, `rustup` with the pinned toolchain and components in `rust-toolchain.toml`, CMake and Ninja. Ensure that toolchain's `cargo`, `rustc` and `rustfmt` precede a separate system Rust installation on `PATH`; a Homebrew stable compiler can otherwise be selected by the native build's child processes. The identity and wording generators run that `rustfmt` too: a stable `rustfmt` ignores `rustfmt.toml`'s unstable options, so its output differs from CI's and the generated commits fail there.

```sh
bun install --frozen-lockfile
bun run build:native                          # Rust addon for this machine
bun --cwd=packages/coding-agent run build     # packages/coding-agent/dist/scient-agent
```

## Checks

```sh
bun scripts/scient/rename-identity.ts --check   # no OMP state name is left in the source
bun scripts/scient/rename-wording.ts --check    # the agent's words name Scient Agent
bun scripts/scient/divergence-check.ts --footprint   # every divergence is generated, owned or marked; how much there is
bun test scripts/scient                         # the checker's own cases
bun run check:ts
CI=1 bun run check:rs                         # force checks even on a clean committed tree
CI=1 NEXTEST_TEST_THREADS=1 bun run test:rs    # native desktop-input tests share a machine lock
bun --cwd=packages/utils test test/scient      # Scient's own tests; also natives, coding-agent and ai
bun scripts/ci-test-ts.ts all                   # Oh My Pi's TypeScript tests, as its CI runs them
bun scripts/scient/isolation-check.ts packages/coding-agent/dist/scient-agent
```

`isolation-check.ts` starts the built binary in empty home directories, with every OMP state variable pointing at a decoy and a proxy recording what it tries to reach. It fails if the agent writes its own state outside its config root, follows one of OMP's variables, touches an OMP home, hands its shell a variable that would steer a stock `omp`, or contacts an OMP service or update source unasked. It prints the hosts contacted. It does not limit what a task may write or reach.

It runs without a model, so it covers startup, the RPC handshake and the agent's shell. Scient Desktop's live suites (`OMP_QUALIFY_TARGET=scient`) cover model turns, subagents, background work and sessions against the same executable.

`capability-check.ts` accepts absolute candidate and previous-binary paths. Run its controller with a disposable HOME as well. It uses isolated child roots and a loopback model stub, and retains synthetic fixture receipts for inspection. It exercises actual native Skill reads, JavaScript eval, shell artifacts, two concurrent children, old-session upgrade and pre-upgrade-snapshot rollback. It does not call a paid model or validate hosted-model judgment. For Desktop coexistence, use a **stock OMP** binary in `OMP_QUALIFY_BINARY` and the native candidate in `SCIENT_AGENT_QUALIFY_BINARY`; `OMP_QUALIFY_TARGET=scient` is for the separate common-suite run, not the coexistence suite.

Oh My Pi's TypeScript tests run in CI on Linux against Scient's tree as upstream's CI ran them: its six test buckets, its release-script test and its CLI smoke test (`upstream-tests`). A release waits for them. A generator renames what an upstream test expects together with the code it checks, so a passing suite means Scient's names reached both.

Each bucket runs through `scripts/scient/upstream-tests.ts`, which runs upstream's `scripts/ci-test-ts.ts` unchanged with `--full`. That flag changes what the runner prints, not what runs: each chunk's whole Bun output is shown, so Bun's own counts can be checked. The quiet report can leave out an error a test file threw while loading. A failed bucket passes only if every failure is listed in the script's `KNOWN_FAILURES`. Each entry names one test, the exact Oh My Pi commit it fails on untouched, and the evidence. Anything else fails the job:
- a test the list does not name;
- an entry recorded for a different commit, so every alignment checks its entries again;
- a chunk that crashed, was killed, or names no test;
- an error outside any test;
- a chunk whose Bun fail count differs from the failures it names;
- a report the script cannot read in full.

Twelve tests are listed for 18.18.6. Each was seen failing on untouched 18.18.6 on the same runner type; the counts are under "Ninth alignment intake". The job sets the 120-second per-test ceiling upstream's CI sets, which removed most of the timing failures listed for 18.13.0.

Scient's own tests live in `test/scient/` folders and run on macOS with the platform-sensitive `utils` and `natives` suites.

## Release

`.github/workflows/scient.yml` builds and checks every platform on every push to `main` and on every pull request into it: macOS (Apple silicon and Intel), Linux (x86-64 and ARM64, glibc) and Windows (x86-64 and ARM64), each on its own GitHub-hosted runner, each with the isolation check. The first step stamps the commit into `packages/coding-agent/src/scient/build-id.ts` (`scripts/scient/stamp-build-id.ts`), which `--runtime-info` reports; a build made elsewhere reports `source`. On x86-64 the binary carries the `modern` (AVX2) and `baseline` native addons (`PI_NATIVE_X64_VARIANT` builds each).

The Intel macOS job restores Cargo dependency artifacts keyed by the compiler, Rust configuration, manifests, lockfile and native-build scripts. Cargo still builds both CPU variants and regenerates and load-checks their bindings; cache misses perform the full build. Each variant has its own timed step. Tests, signing, packaging and signed-binary checks still run, and other platforms build without this cache.

The macOS builds are signed by upstream's `scripts/ci-macos-sign.sh`, unchanged, on a Linux runner (it uses a pinned `rcodesign`): ad hoc on every run, so the signing path is exercised by every pull request. A separate job then runs the signed bytes on their own macOS runner: checksum, `codesign --verify --strict`, `--version` and the isolation check. An unsigned macOS build is uploaded under an `unsigned-` name and can never reach a release.

Pushing a `v<version>` tag that matches `scient.json` signs the macOS builds with the Developer ID, notarizes them, refuses an ad-hoc signature, and drafts a GitHub release with every binary, its zstd copy (`<binary>.zst`) and the SHA-256 of each. A person publishes the draft. The same job copies them all to `downloads.scientfactory.com/scient-agent/v<version>/` (Cloudflare R2; secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and variable `R2_DOWNLOADS_BUCKET`). Scient Desktop downloads that copy first and falls back to the GitHub release, and its catalog publishes a version only after every copy matches the digest. Desktop prefers the zstd copy, about 40% of the binary's size, unpacks it and checks the binary's SHA-256; it falls back to the binary itself, and Desktops that predate the copies download only the binary. The `compress` job makes the copies on every run with `zstd -19 --long=27` and checks that each unpacks to its binary: Desktop allows a window of at most 2^27 bytes, and the check unpacks with the same limit. A manual run of the workflow with `developer-id` set signs and notarizes without drafting a release; use it to qualify the signing secrets before tagging. Not built yet: Linux with musl (Alpine). The Windows builds are not code-signed.

Signing uses the same five repository secrets, in the same form, as Scient Desktop's release: `CSC_LINK` (the Developer ID Application certificate as a base64 `.p12`), `CSC_KEY_PASSWORD`, `APPLE_API_KEY` (the App Store Connect `.p8` key's text), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.
