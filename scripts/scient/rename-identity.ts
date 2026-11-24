#!/usr/bin/env bun
/**
 * Renames the names Oh My Pi gives itself where a program or the system reads
 * them, so Scient Agent and a stock `omp` on the same machine never read, write,
 * or steer each other, and the system tells them apart:
 *
 * - the `.omp` config directory (home and project) becomes `.scient-agent`;
 * - the environment variables that select a home, profile, settings overlay,
 *   session directory, worktree base, auth broker, database, runtime
 *   directory or socket get `SCIENT_AGENT_*` names;
 * - Windows named pipes and relocated Unix sockets carry the product's name;
 * - the executable, its XDG and temporary folders, log files, sign-in helper
 *   applications, the services it registers with, and the browser relay's port
 *   are Scient Agent's (`NAMES`).
 *
 * What a person or a model reads is `rename-wording.ts`'s.
 *
 * The result is committed as its own generated commit. After taking a newer
 * upstream release, drop that commit and run this again instead of resolving
 * its conflicts by hand.
 *
 *   bun scripts/scient/rename-identity.ts          rewrite the tree
 *   bun scripts/scient/rename-identity.ts --check  fail when an upstream name remains
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";
import { formatTools } from "./lib/format";

/** Sources that are built into, tested with, or documented inside the agent. */
const ROOTS = ["packages", "crates", "docs"];

const PRODUCT = "Scient Agent";
const COMMAND = "scient-agent";

const RENAMES: ReadonlyArray<readonly [RegExp, string]> = [
	// Only where `.omp` is a path segment: after a quote, slash, paren, or tilde, or as a
	// bare word in prose. A property access (`pkg?.omp`, the plugin manifest key) and a
	// CSS class (`.omp-mark`) are not the directory. `.omp-plugin` also stays: it is the
	// marketplace catalog format third-party plugins publish.
	[/(?<=^|[/"'`(\\~])\.omp(?![A-Za-z0-9_]|-plugin)|(?<=\s)\.omp(?![A-Za-z0-9_-])/gm, ".scient-agent"],
	[/\bPI_CONFIG_DIR\b/g, "SCIENT_AGENT_CONFIG_DIR"],
	[/\bPI_CONFIG_FILES\b/g, "SCIENT_AGENT_CONFIG_FILES"],
	[/\bPI_NATIVES_DIR\b/g, "SCIENT_AGENT_NATIVES_DIR"],
	[/\bPI_CODING_AGENT_SESSION_DIR\b/g, "SCIENT_AGENT_SESSION_DIR"],
	[/\bPI_CODING_AGENT_DIR\b/g, "SCIENT_AGENT_DIR"],
	[/\bOMP_PROFILE\b/g, "SCIENT_AGENT_PROFILE"],
	// Upstream's legacy alias, consulted only when the canonical variable is unset.
	[/\bPI_PROFILE\b/g, "SCIENT_AGENT_PROFILE_FALLBACK"],
	[/\bOMP_WORKTREE_DIR\b/g, "SCIENT_AGENT_WORKTREE_DIR"],
	[/\bOMP_AUTH_BROKER_/g, "SCIENT_AGENT_AUTH_BROKER_"],
	// Overrides for where a database, runtime directory, socket, or native library
	// lives, and the configuration the agent hands its own worker processes.
	[
		/\bOMP_(GITHUB_CACHE_DB|COMMIT_CACHE_DB|JUDGMENT_CACHE_DB|AUTORESEARCH_DB_DIR|DAEMON_DIR|DAEMON_TCP|DAEMON_RESUME|DISASM_WORKER_TOKEN|TUI_DEBUG|NATIVE_LIBRARY_PATH)\b/g,
		"SCIENT_AGENT_$1",
	],
	// Windows named pipes are machine-wide, so the name is all that separates two products.
	// One backslash in a Rust raw string, two in a JavaScript string.
	[/(?<=pipe\\{1,2})omp-/g, `${COMMAND}-`],
	// Per-user directories in /tmp: relocated sockets whose path is too long for the
	// platform, recordings, shell snapshots, and the examples and tests that name them.
	[/(?<=\/tmp\/)omp-/g, `${COMMAND}-`],
	// Log files, `omp.<day>.<pid>.log`, in the code that writes and prunes them and the
	// tests and docs that name them: as a literal, a template, a regular expression, a
	// glob, or a `<day>` placeholder. The disassembler's `omp.${backend}.` names its hosts
	// in the agent's own broker, not a log file, and its open-database limit counts them by
	// that prefix.
	[/(?<=[`"'/^])omp(?=\\?\.(?:\$\{(?!backend\})|\(\\d|\[\\d|\\d|\d{4}|<\w+>\.<\w+>\.log|\*\.log))/g, COMMAND],
	[/\bfilenamePrefix: "omp"/g, `filenamePrefix: "${COMMAND}"`],
	// The browser relay's port: two relays on one port would adopt each other's browser.
	[/(?<=DEFAULT_PORT = |127\.0\.0\.1:)9224\b/g, "9324"],
	// The Chrome native-messaging host the relay extension connects to: one registration per
	// name (a manifest on macOS and Linux, a registry key on Windows), so two products under one
	// name overwrite each other's launcher and allowed extensions.
	[/\bsh\.omp\.browser\b/g, "com.scientfactory.agent.browser"],
	// What the native host hands the session it starts: the panel's relay, a Chrome-only browser
	// and the session's origin. Inherited by the other product, they would steer it.
	[/\bPI_(PANEL_RELAY_URL|BROWSER_RELAY|SESSION_ORIGIN)\b/g, "SCIENT_AGENT_$1"],
];

/**
 * Names that the rules above cannot reach, each an exact replacement in one
 * file. A listed text that is in neither form means upstream moved it: look
 * again, then fix the list.
 *
 * Not listed, on purpose: the names a provider recognizes its client by (the
 * `originator`, a provider's own `User-Agent`), the terminal handshake, Warp's agent name,
 * the `omp://` scheme, the `omp` key of a plugin's `package.json`, and the line
 * a background process prints for another to match. SCIENT.md lists them.
 */
const NAMES: Record<string, [from: string, to: string][]> = {
	// The executable.
	"packages/coding-agent/package.json": [['"omp": "src/cli.ts"', `"${COMMAND}": "src/cli.ts"`]],
	"packages/coding-agent/scripts/build-binary.ts": [
		[`\`omp-\${crossBuild.id}\` : "omp"`, `\`${COMMAND}-\${crossBuild.id}\` : "${COMMAND}"`],
	],
	"scripts/ci-release-build-binaries.ts": [
		["packages/coding-agent/binaries/omp-", `packages/coding-agent/binaries/${COMMAND}-`],
	],
	"packages/coding-agent/src/subprocess/worker-client.ts": [
		['$which("omp", {', `$which("${COMMAND}", {`],
		['finding "omp" on PATH', `finding "${COMMAND}" on PATH`],
	],
	"sdk/python/omp-rpc/src/omp_rpc/client.py": [['executable: str = "omp"', `executable: str = "${COMMAND}"`]],
	// The app name, the folder it names under XDG, and its homepage.
	"packages/utils/src/dirs.ts": [
		['export const APP_NAME: string = "omp";', `export const APP_NAME: string = "${COMMAND}";`],
		[
			'export const APP_URL: string = "https://omp.sh/";',
			'export const APP_URL: string = "https://scientfactory.com/";',
		],
		['return value ? value : "omp";', `return value ? value : "${COMMAND}";`],
	],
	// The User-Agent names the app (`APP_NAME/<version>`); a test that reads it names it too.
	// The Git view's GitHub avatar lookup names the app to GitHub.
	"packages/coding-agent/src/cli/git-tui/avatar.ts": [['"User-Agent": "omp"', `"User-Agent": "${COMMAND}"`]],
	"packages/coding-agent/test/spotlight/wire.test.ts": [['toStartWith("omp/")', `toStartWith("${COMMAND}/")`]],
	"packages/coding-agent/src/cli/commands/init-xdg.ts": [
		['const APP_NAME = "omp";', `const APP_NAME = "${COMMAND}";`],
	],
	"packages/tui/src/desktop-notify.ts": [['const APP_NAME = "omp";', `const APP_NAME = "${COMMAND}";`]],
	"packages/tui/test/desktop-notify.test.ts": [
		['"omp",', `"${COMMAND}",`],
		['title: "omp"', `title: "${COMMAND}"`],
	],
	"crates/natives/src/crash_handler.rs": [
		['const APP_NAME: &str = "omp";', `const APP_NAME: &str = "${COMMAND}";`],
		['"/xdg/state/omp/logs"', `"/xdg/state/${COMMAND}/logs"`],
	],
	"crates/natives/src/desktop/linux/wayland/portal.rs": [['base.join("omp")', `base.join("${COMMAND}")`]],
	// X11 input pairs are machine-wide: the master name and holder property decide which
	// product may adopt or free a pair, and every product's pairs count toward one limit.
	// The name also names the uinput devices, which must stay under 80 bytes, so the
	// prefix is short.
	"crates/natives/src/desktop/linux/x11/mpx.rs": [
		['const OWNER_PREFIX: &str = "OMP MPX v2.";', 'const OWNER_PREFIX: &str = "SCIENT MPX v2.";'],
		['const HOLDER_PROPERTY: &str = "_OMP_MPX_HOLDER";', 'const HOLDER_PROPERTY: &str = "_SCIENT_MPX_HOLDER";'],
	],
	"crates/natives/src/desktop/linux/x11/wm.rs": [
		["/// `_OMP_MPX_HOLDER`, the master", "/// `_SCIENT_MPX_HOLDER`, the master"],
		['"_OMP_MPX_HOLDER",', '"_SCIENT_MPX_HOLDER",'],
	],
	"crates/natives/src/desktop/linux/x11/listener.rs": [
		['const DEVICE_PREFIX: &str = "OMP MPX ";', 'const DEVICE_PREFIX: &str = "SCIENT MPX ";'],
	],
	"packages/natives/native/loader-state.js": [
		['path.join(xdgDataHome, "omp")', `path.join(xdgDataHome, "${COMMAND}")`],
		['path.join(xdgDataHome, "omp", "natives")', `path.join(xdgDataHome, "${COMMAND}", "natives")`],
		['"AppData", "Local"), "omp")', `"AppData", "Local"), "${COMMAND}")`],
	],
	"packages/natives/test/natives-dir-override.test.ts": [
		['path.join(xdgData, "omp")', `path.join(xdgData, "${COMMAND}")`],
		['path.join(xdgData, "omp", "natives"', `path.join(xdgData, "${COMMAND}", "natives"`],
	],
	"packages/utils/test/dirs-python-gateway.test.ts": [['XDG_STATE_HOME, "omp"', `XDG_STATE_HOME, "${COMMAND}"`]],
	"packages/utils/test/dirs-xdg.test.ts": [
		["$XDG_DATA_HOME/omp", `$XDG_DATA_HOME/${COMMAND}`],
		['path.join(xdgData, "omp"', `path.join(xdgData, "${COMMAND}"`],
		['path.join(xdgState, "omp"', `path.join(xdgState, "${COMMAND}"`],
	],
	"packages/utils/test/natives-dir-override.test.ts": [
		['path.join(cache, "omp"', `path.join(cache, "${COMMAND}"`],
		['path.join(data, "omp"', `path.join(data, "${COMMAND}"`],
	],
	"packages/utils/test/profiles.test.ts": [
		['XDG_DATA_HOME, "omp"', `XDG_DATA_HOME, "${COMMAND}"`],
		['XDG_STATE_HOME, "omp"', `XDG_STATE_HOME, "${COMMAND}"`],
		['XDG_CACHE_HOME, "omp"', `XDG_CACHE_HOME, "${COMMAND}"`],
		['path.join(xdgStateRoot, "omp"', `path.join(xdgStateRoot, "${COMMAND}"`],
	],
	"packages/tui/test/composer-cache.test.ts": [
		['path.join(xdgCache, "omp")', `path.join(xdgCache, "${COMMAND}")`],
		['JSON.stringify(xdgCache)}, "omp"', `JSON.stringify(xdgCache)}, "${COMMAND}"`],
	],
	"packages/coding-agent/test/debug/raw-sse-report-bundle.test.ts": [
		['path.join(xdgStateHome, "omp")', `path.join(xdgStateHome, "${COMMAND}")`],
	],
	"packages/coding-agent/test/debug/report-bundle-logs.test.ts": [
		['path.join(xdgStateHome, "omp")', `path.join(xdgStateHome, "${COMMAND}")`],
	],
	"packages/coding-agent/test/debug/report-bundle-sessions.test.ts": [
		['path.join(xdgStateHome, "omp")', `path.join(xdgStateHome, "${COMMAND}")`],
	],
	"packages/coding-agent/test/legacy-pi-extension-cache.test.ts": [
		["`<cacheRoot>/omp` layout", `\`<cacheRoot>/${COMMAND}\` layout`],
		['_CONFIG_DIR = "omp";', `_CONFIG_DIR = "${COMMAND}";`],
		['path.join(cacheRoot, "omp"', `path.join(cacheRoot, "${COMMAND}"`],
	],
	"packages/coding-agent/test/skill-descriptions-xdg.test.ts": [
		['path.join(xdgData, "omp"', `path.join(xdgData, "${COMMAND}"`],
	],
	"packages/coding-agent/test/slash-commands/resume.test.ts": [
		['path.join(xdgDataDir, "omp")', `path.join(xdgDataDir, "${COMMAND}")`],
	],
	// Folders in the temporary directory.
	"packages/coding-agent/src/internal-urls/local-root.ts": [['"omp-local"', `"${COMMAND}-local"`]],
	"packages/coding-agent/test/internal-urls/local-protocol.test.ts": [['"omp-local"', `"${COMMAND}-local"`]],
	"packages/coding-agent/test/tools/plan-mode-guard-local.test.ts": [['"omp-local"', `"${COMMAND}-local"`]],
	"packages/coding-agent/src/internal-urls/filesystem-resource.ts": [['"omp-resource"', `"${COMMAND}-resource"`]],
	"packages/coding-agent/src/edit/remote-mirror.ts": [['"omp-remote-edit"', `"${COMMAND}-remote-edit"`]],
	"packages/coding-agent/src/stream/recording.ts": [['"omp-recordings"', `"${COMMAND}-recordings"`]],
	"packages/coding-agent/src/utils/shell-snapshot.ts": [["omp-shell-snapshots", `${COMMAND}-shell-snapshots`]],
	"packages/coding-agent/test/shell-snapshot.test.ts": [["omp-shell-snapshots", `${COMMAND}-shell-snapshots`]],
	// Browser upload staging: the sweep removes another process's folder once that process is gone.
	"packages/coding-agent/src/tools/browser/upload-files.ts": [["omp-uploads-", `${COMMAND}-uploads-`]],
	"packages/coding-agent/test/tools/browser-upload-contents.test.ts": [["omp-uploads-", `${COMMAND}-uploads-`]],
	// The process a system dialog names, and git's committer on an agent's ref update.
	// The program the shell hands internal URLs to unresolved: the one that reads them.
	"crates/shell/src/host/urls.rs": [
		[
			'name == b"omp" || (cfg!(windows) && name.eq_ignore_ascii_case(b"omp.exe"))',
			`name == b"${COMMAND}" || (cfg!(windows) && name.eq_ignore_ascii_case(b"${COMMAND}.exe"))`,
		],
	],
	"packages/coding-agent/src/tools/bash-host-urls.ts": [
		['return name === "omp" || name === "omp.exe";', `return name === "${COMMAND}" || name === "${COMMAND}.exe";`],
	],
	"packages/coding-agent/test/tools/bash-host-urls.test.ts": [
		['"sudo /usr/local/bin/omp read local://x.md"', `"sudo /usr/local/bin/${COMMAND} read local://x.md"`],
	],
	"packages/coding-agent/test/tools/bash-url-filesystem.test.ts": [
		['path.join(tempDir, "omp")', `path.join(tempDir, "${COMMAND}")`],
	],
	"crates/shell/tests/vfs.rs": [
		['bin.path().join("omp")', `bin.path().join("${COMMAND}")`],
		[" omp read virtual://", ` ${COMMAND} read virtual://`],
	],
	"crates/natives/src/power.rs": [['const INHIBIT_WHO: &str = "omp";', `const INHIBIT_WHO: &str = "${COMMAND}";`]],
	"crates/vcs/src/git/mutate.rs": [
		['"omp".into()', `"${COMMAND}".into()`],
		['"omp@localhost"', `"${COMMAND}@localhost"`],
	],
	// Sign-in helper applications and the transaction marker each platform registers.
	"crates/natives/src/oauth_callback/darwin.rs": [
		[
			'const BUNDLE_PREFIX: &str = "dev.omp.oauth-callback.";',
			'const BUNDLE_PREFIX: &str = "com.scientfactory.agent.oauth-callback.";',
		],
		['const APP_PREFIX: &str = "omp OAuth Callback ";', `const APP_PREFIX: &str = "${PRODUCT} OAuth Callback ";`],
		[
			'const STAGING_APP_NAME: &str = "OMP OAuth Callback.app";',
			`const STAGING_APP_NAME: &str = "${PRODUCT} OAuth Callback.app";`,
		],
		[
			'"home/Applications/omp OAuth Callback abandoned.app"',
			`"home/Applications/${PRODUCT} OAuth Callback abandoned.app"`,
		],
		['"dev.omp.oauth-callback.aaaaaaaa', '"com.scientfactory.agent.oauth-callback.aaaaaaaa'],
	],
	"crates/natives/src/oauth_callback/linux.rs": [
		[
			'const DESKTOP_ID_PREFIX: &str = "dev.omp.oauth-callback.";',
			'const DESKTOP_ID_PREFIX: &str = "com.scientfactory.agent.oauth-callback.";',
		],
	],
	"crates/natives/src/oauth_callback/windows.rs": [
		['"omp OAuth Callback Transaction"', `"${PRODUCT} OAuth Callback Transaction"`],
	],
	// What the agent registers as with services it signs in to or reports to.
	"packages/ai/test/openai-compat-user-agent.test.ts": [
		["toMatch(/^omp\\/\\d+\\.\\d+\\.\\d+$/)", `toMatch(/^${COMMAND}\\/\\d+\\.\\d+\\.\\d+$/)`],
	],
	"packages/ai/test/vercel-gateway-attribution.test.ts": [
		[
			'\t\t\t\t"https://omp.sh/",\n\t\t\t\t"omp",\n',
			`\t\t\t\t"https://scientfactory.com/",\n\t\t\t\t"${COMMAND}",\n`,
		],
	],
	"packages/ai/test/auth-broker-remote-store.test.ts": [['p.app === "omp"', `p.app === "${COMMAND}"`]],
	"packages/mnemopi/test/optional-embeddings.test.ts": [
		['get("http-referer")).toBe("https://omp.sh/")', 'get("http-referer")).toBe("https://scientfactory.com/")'],
		['get("x-openrouter-title")).toBe("omp")', `get("x-openrouter-title")).toBe("${COMMAND}")`],
	],
	// Dynamic client registration names the client on the person's consent screen: Scient Agent, not
	// the "Codex" Oh My Pi 19.1 registers as.
	// Chrome's profile backups the relay writes before registering, the overlay element the
	// extension mounts in a page and removes by tag, the command the side panel copies to resume
	// its session in a terminal, image temp files named by content, and the Binary Ninja runner's
	// staging folder: two products sharing one would overwrite or remove the other's.
	"packages/coding-agent/src/tools/browser/relay/chrome/secure-store.ts": [
		["`${file}.omp-backup`", `\`\${file}.${COMMAND}-backup\``],
	],
	"packages/coding-agent/test/tools/browser-relay-chrome-prefs.test.ts": [
		// Chrome hashed this exact extension path when it wrote the recorded authenticator.
		[`"/Users/can/.${COMMAND}/browser-relay/extension"`, '"/Users/can/.omp/browser-relay/extension"'],
		["`${secureFile}.omp-backup`", `\`\${secureFile}.${COMMAND}-backup\``],
	],
	"packages/coding-agent/src/tools/browser/relay/protocol.ts": [
		['OVERLAY_HOST_TAG = "omp-overlay"', `OVERLAY_HOST_TAG = "${COMMAND}-overlay"`],
	],
	"packages/coding-agent/test/tools/browser-interactions.test.ts": [
		["<omp-overlay></omp-overlay>", `<${COMMAND}-overlay></${COMMAND}-overlay>`],
		['document.querySelector("omp-overlay")', `document.querySelector("${COMMAND}-overlay")`],
		['document.createElement("OMP-OVERLAY")', `document.createElement("${COMMAND.toUpperCase()}-OVERLAY")`],
	],
	"packages/browser-relay/extension/panel/app.tsx": [
		["`omp --resume ${sessionId}`", `\`${COMMAND} --resume \${sessionId}\``],
	],
	"packages/coding-agent/src/utils/image-temp.ts": [["`omp-image-${", `\`${COMMAND}-image-\${`]],
	"packages/coding-agent/src/disasm/backend.ts": [
		['workerStageDir: "omp-binja-worker"', `workerStageDir: "${COMMAND}-binja-worker"`],
	],
	// The Codex client version record lives under the XDG cache folder the app names.
	"packages/catalog/test/codex-client-version-xdg.test.ts": [
		['path.join(xdgCache, "omp")', `path.join(xdgCache, "${COMMAND}")`],
		[
			'process.env.XDG_CACHE_HOME!, "omp", "codex-client-version.json"',
			`process.env.XDG_CACHE_HOME!, "${COMMAND}", "codex-client-version.json"`,
		],
		["$XDG_CACHE_HOME/omp", `$XDG_CACHE_HOME/${COMMAND}`],
	],
	"packages/coding-agent/src/mcp/oauth-flow.ts": [['client_name: "Codex"', `client_name: "${PRODUCT}"`]],
	"packages/coding-agent/test/oauth-flow.test.ts": [['client_name).toBe("Codex")', `client_name).toBe("${PRODUCT}")`]],
	"packages/coding-agent/src/telemetry-export-otlp.ts": [
		['const SERVICE_NAME = "oh-my-pi";', `const SERVICE_NAME = "${COMMAND}";`],
	],
	"packages/coding-agent/src/tools/report-tool-issue.ts": [
		['agent: { name: "omp", version: VERSION }', `agent: { name: "${COMMAND}", version: VERSION }`],
	],
	"packages/coding-agent/test/tools/report-tool-issue.test.ts": [
		['expect(body.agent?.name).toBe("omp")', `expect(body.agent?.name).toBe("${COMMAND}")`],
	],
	// The client names editors and debug adapters receive (their display titles are wording).
	"packages/coding-agent/src/modes/acp/acp-agent.ts": [['name: "omp"', `name: "${COMMAND}"`]],
	"packages/coding-agent/src/dap/session.ts": [['clientID: "omp"', `clientID: "${COMMAND}"`]],
	// The default memory bank, which a Hindsight server shares between agents.
	"packages/coding-agent/src/hindsight/bank.ts": [
		['const DEFAULT_BANK_NAME = "omp";', `const DEFAULT_BANK_NAME = "${COMMAND}";`],
	],
	"packages/coding-agent/src/hindsight/settings.ts": [['default: "omp"', `default: "${COMMAND}"`]],
	// Every bank id these tests name is the default or derives from it.
	"packages/coding-agent/test/hindsight-bank.test.ts": [
		['"omp"', `"${COMMAND}"`],
		['"omp-', `"${COMMAND}-`],
	],
	"packages/coding-agent/test/hindsight-backend.test.ts": [
		['"omp"', `"${COMMAND}"`],
		['"omp-', `"${COMMAND}-`],
	],
	// The browser relay's tab group.
	"packages/coding-agent/src/tools/browser/relay/server.ts": [
		[
			'const DEFAULT_GROUP = { title: "omp", color: "cyan" }',
			`const DEFAULT_GROUP = { title: "${COMMAND}", color: "cyan" }`,
		],
	],
	// Shell profile aliases: the command they run and the blocks that hold them.
	"packages/coding-agent/src/cli/profile-alias.ts": [
		['display: "omp",', `display: "${COMMAND}",`],
		['posix: "omp",', `posix: "${COMMAND}",`],
		['fish: "omp",', `fish: "${COMMAND}",`],
		['powerShell: "omp",', `powerShell: "${COMMAND}",`],
		['normalized.toLowerCase() === "omp"', `normalized.toLowerCase() === "${COMMAND}"`],
		[
			`'Invalid alias "omp". Refusing to shadow the base omp command.'`,
			`'Invalid alias "${COMMAND}". Refusing to shadow the base ${COMMAND} command.'`,
		],
		['"omp-profiles.fish"', `"${COMMAND}-profiles.fish"`],
		["omp profile alias:", `${COMMAND} profile alias:`],
		["--wraps omp --description 'OMP profile", `--wraps ${COMMAND} --description '${COMMAND} profile`],
	],
	"packages/coding-agent/test/profile-alias.test.ts": [
		['toBe("omp --profile=work")', `toBe("${COMMAND} --profile=work")`],
		["command omp --profile=", `command ${COMMAND} --profile=`],
		['display: "omp",', `display: "${COMMAND}",`],
		['posix: "omp",', `posix: "${COMMAND}",`],
		['fish: "omp",', `fish: "${COMMAND}",`],
		['powerShell: "omp",', `powerShell: "${COMMAND}",`],
		["omp-profiles.fish", `${COMMAND}-profiles.fish`],
		["--wraps omp", `--wraps ${COMMAND}`],
		["& omp --profile=", `& ${COMMAND} --profile=`],
		["omp profile alias:", `${COMMAND} profile alias:`],
		['["omp", "OMP"]', `["${COMMAND}", "${COMMAND.toUpperCase()}"]`],
	],
	// Tests whose expectations the renamed executable decides: what Oh My Pi's
	// updater and build service (off in Scient Agent) look for, the worker
	// fallback's PATH lookup, completions, the run-status record, and session
	// breadcrumbs.
	"packages/coding-agent/test/update-cli.test.ts": [
		['parseReportedVersion("omp/', `parseReportedVersion("${COMMAND}/`],
		["echo omp/", `echo ${COMMAND}/`],
		['"omp.cmd"', `"${COMMAND}.cmd"`],
		['"omp.exe"', `"${COMMAND}.exe"`],
		['"omp.ps1"', `"${COMMAND}.ps1"`],
		['"omp.bunx"', `"${COMMAND}.bunx"`],
		['path.join(dir, "omp")', `path.join(dir, "${COMMAND}")`],
		['path.join(dir, "opt", "omp")', `path.join(dir, "opt", "${COMMAND}")`],
		['path.join(prefix, "bin", "omp")', `path.join(prefix, "bin", "${COMMAND}")`],
		['path.join(linkedBin, "omp")', `path.join(linkedBin, "${COMMAND}")`],
		['path.join(first, "omp")', `path.join(first, "${COMMAND}")`],
		['path.join(second, "omp")', `path.join(second, "${COMMAND}")`],
		["restored previous omp binary", `restored previous ${COMMAND} binary`],
		["restored previous omp launcher", `restored previous ${COMMAND} launcher`],
		['omp: "#!/bin/sh', `"${COMMAND}": "#!/bin/sh`],
		["$PSScriptRoot\\\\omp.exe", `$PSScriptRoot\\\\${COMMAND}.exe`],
	],
	"packages/coding-agent/test/cli/update-cli.test.ts": [
		['path.join(dir, "omp")', `path.join(dir, "${COMMAND}")`],
		["echo omp/", `echo ${COMMAND}/`],
	],
	"packages/coding-agent/test/cli/build-service.test.ts": [
		['fileName: "omp-', `fileName: "${COMMAND}-`],
		['const fileName = "omp-darwin-arm64";', `const fileName = "${COMMAND}-darwin-arm64";`],
		['"omp-darwin-x64 is not omp-darwin-arm64"', `"omp-darwin-x64 is not ${COMMAND}-darwin-arm64"`],
		[`toBe(\`omp/\${VERSION}\`)`, `toBe(\`${COMMAND}/\${VERSION}\`)`],
	],
	"packages/coding-agent/test/executable-fallback.test.ts": [
		['if (cmd === "omp")', `if (cmd === "${COMMAND}")`],
		['expect(whichCalledWith).toBe("omp")', `expect(whichCalledWith).toBe("${COMMAND}")`],
	],
	"packages/coding-agent/test/cli/completions.test.ts": [
		['"command omp __complete $kind"', `"command ${COMMAND} __complete $kind"`],
	],
	"packages/coding-agent/test/run-status.test.ts": [["app=omp", `app=${COMMAND}`]],
	"packages/coding-agent/test/modes/controllers/extension-ui-controller.test.ts": [["app=omp", `app=${COMMAND}`]],
	"packages/coding-agent/test/gc-cli.test.ts": [
		["\\n.omp-sessions/work.jsonl", "\\n.scient-agent-sessions/work.jsonl"],
	],
	// Help rendered for a command group names the executable.
	"packages/coding-agent/src/commands/agents.ts": [['renderCommandHelp("omp",', `renderCommandHelp("${COMMAND}",`]],
	"packages/coding-agent/src/commands/auth-broker.ts": [
		['renderCommandHelp("omp",', `renderCommandHelp("${COMMAND}",`],
	],
	"packages/coding-agent/src/commands/auth-gateway.ts": [
		['renderCommandHelp("omp",', `renderCommandHelp("${COMMAND}",`],
		// The example clients file: tokens and accounts are each product's own.
		["--clients=/etc/omp/", `--clients=/etc/${COMMAND}/`],
	],
};

/**
 * Files the rules above would rewrite but must not: their names are examples
 * measured byte by byte, and the code they check keeps upstream's spelling.
 */
const KEPT_FILES = new Set([
	// SSH control sockets stay inside macOS's 104-byte sun_path. The fallback
	// folder is `/tmp/omp-<hash>`, and the hash of Scient Agent's own canonical
	// folder already keeps it apart; a longer name would eat the slack the
	// budget leaves.
	"packages/coding-agent/test/ssh-control-path.test.ts",
]);

/** One file's text with every `RENAMES` rule applied. */
export function applyRenames(text: string): string {
	let result = text;
	for (const [pattern, replacement] of RENAMES) result = result.replace(pattern, replacement);
	return result;
}

/**
 * The exempted files that are no longer where `kept` says. An exemption whose
 * file moved would silently stop applying, and the moved file would be renamed.
 */
export function missingKeptFiles(exists: (file: string) => boolean, kept: ReadonlySet<string> = KEPT_FILES): string[] {
	return [...kept].filter(file => !exists(file));
}

if (import.meta.main) {
	const check = process.argv.includes("--check");
	const repoRoot = path.resolve(import.meta.dir, "..", "..");
	const exists = (file: string) => fs.existsSync(path.join(repoRoot, file));
	const keptMissing = missingKeptFiles(exists);
	if (keptMissing.length > 0) {
		console.error(`Exempted files that are no longer where KEPT_FILES says:\n  ${keptMissing.join("\n  ")}`);
		process.exit(1);
	}

	const files = (await $`git -C ${repoRoot} ls-files -z -- ${ROOTS}`.quiet().text()).split("\0").filter(Boolean);

	let changed = 0;
	const native = new Set<string>();
	const remaining = new Set<string>();
	const contents = new Map<string, { before: string; after: string }>();

	for (const file of files) {
		// Changelogs record upstream history under its own names.
		if (path.basename(file).startsWith("CHANGELOG")) continue;
		// Scient's own code and tests (anything under a `scient/` folder) say what they mean.
		if (/(?:^|\/)scient\//.test(file) || KEPT_FILES.has(file)) continue;
		const handle = Bun.file(path.join(repoRoot, file));
		if (!(await handle.exists())) continue;
		const bytes = new Uint8Array(await handle.arrayBuffer());
		if (bytes.includes(0)) continue;
		const before = new TextDecoder().decode(bytes);
		const after = applyRenames(before);
		if (after !== before) contents.set(file, { before, after });
	}

	const missing: string[] = [];
	for (const [file, names] of Object.entries(NAMES)) {
		if (!exists(file)) {
			missing.push(`${file} (no such file)`);
			continue;
		}
		const entry = contents.get(file);
		const before = entry?.before ?? (await Bun.file(path.join(repoRoot, file)).text());
		let after = entry?.after ?? before;
		for (const [from, to] of names) {
			if (after.includes(from)) after = after.replaceAll(from, to);
			else if (!after.includes(to)) missing.push(`${file}: ${from}`);
		}
		if (after !== before) contents.set(file, { before, after });
		else contents.delete(file); // A file-local rule can undo a global rename.
	}
	if (missing.length > 0) {
		console.error(`Listed names that are no longer in the source:\n  ${missing.join("\n  ")}`);
		process.exit(1);
	}

	for (const [file, { after }] of contents) {
		if (check) {
			remaining.add(file);
			continue;
		}
		await Bun.write(path.join(repoRoot, file), after);
		if (file.endsWith(".rs")) native.add(file);
		changed++;
	}

	if (check) {
		if (remaining.size > 0) {
			console.error(`${remaining.size} files still use an Oh My Pi name:\n${[...remaining].join("\n")}`);
			console.error("\nRun: bun scripts/scient/rename-identity.ts");
			process.exit(1);
		}
		console.log("No Oh My Pi names remain.");
	} else {
		console.log(`Renamed Oh My Pi names in ${changed} files.`);
		// The new names are longer, so some lines need rewrapping. A formatter that is
		// missing or fails stops the run: unformatted output would differ by machine.
		if (changed > 0) await formatTools(repoRoot);
		if (native.size > 0) await $`rustfmt ${[...native]}`.cwd(repoRoot).quiet();
	}
}
