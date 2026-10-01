#!/usr/bin/env bun
/**
 * Renames the names Oh My Pi uses to find its own state, so Scient Agent and a
 * stock `omp` on the same machine never read, write, or steer each other:
 *
 * - the `.omp` config directory (home and project) becomes `.scient-agent`;
 * - the environment variables that select a home, profile, settings overlay,
 *   session directory, worktree base, auth broker, database, runtime
 *   directory or socket get `SCIENT_AGENT_*` names;
 * - Windows named pipes carry the product's name.
 *
 * The result is committed as its own generated commit. After taking a newer
 * upstream release, drop that commit and run this again instead of resolving
 * its conflicts by hand.
 *
 *   bun scripts/scient/rename-identity.ts          rewrite the tree
 *   bun scripts/scient/rename-identity.ts --check  fail when an upstream name remains
 */
import * as path from "node:path";
import { $ } from "bun";

/** Sources that are built into, tested with, or documented inside the agent. */
const ROOTS = ["packages", "crates", "docs"];

const RENAMES: ReadonlyArray<readonly [RegExp, string]> = [
	// Only where `.omp` is a path segment: after a quote, slash, paren, or tilde, or as a
	// bare word in prose. A property access (`pkg?.omp`, the plugin manifest key) and a
	// CSS class (`.omp-mark`) are not the directory. `.omp-plugin` also stays: it is the
	// marketplace catalog format third-party plugins publish.
	[/(?<=^|[/"'`(\\~])\.omp(?![A-Za-z0-9_]|-plugin)|(?<=\s)\.omp(?![A-Za-z0-9_-])/gm, ".scient-agent"],
	[/\bPI_CONFIG_DIR\b/g, "SCIENT_AGENT_CONFIG_DIR"],
	[/\bPI_CONFIG_FILES\b/g, "SCIENT_AGENT_CONFIG_FILES"],
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
		/\bOMP_(GITHUB_CACHE_DB|COMMIT_CACHE_DB|JUDGMENT_CACHE_DB|AUTORESEARCH_DB_DIR|DAEMON_RUNTIME_DIR|DAEMON_PROJECT_DIR|LSP_MUX_SOCKET|LSP_MUX_PROJECT_DIR|TINY_WORKER_SOCKET|TEXT_PREDICT_SOCKET|TEXT_PREDICT_AGENT_DIR|BLOB_BROKER_SOCKET|BLOB_BROKER_CONFIG|IDA_HOST_CONFIG|TUI_DEBUG|NATIVE_LIBRARY_PATH)\b/g,
		"SCIENT_AGENT_$1",
	],
	// Windows named pipes are machine-wide, so the name is all that separates two products.
	[/(?<=pipe\\\\)omp-/g, "scient-agent-"],
];

const check = process.argv.includes("--check");
const repoRoot = path.resolve(import.meta.dir, "..", "..");
const files = (await $`git -C ${repoRoot} ls-files -z -- ${ROOTS}`.quiet().text()).split("\0").filter(Boolean);

let changed = 0;
const remaining: string[] = [];
for (const file of files) {
	// Changelogs record upstream history under its own names.
	if (path.basename(file).startsWith("CHANGELOG")) continue;
	const absolute = path.join(repoRoot, file);
	const handle = Bun.file(absolute);
	if (!(await handle.exists())) continue;
	const bytes = new Uint8Array(await handle.arrayBuffer());
	if (bytes.includes(0)) continue;
	const before = new TextDecoder().decode(bytes);
	let after = before;
	for (const [pattern, replacement] of RENAMES) after = after.replace(pattern, replacement);
	if (after === before) continue;
	if (check) {
		remaining.push(file);
		continue;
	}
	await Bun.write(absolute, after);
	changed++;
}

if (check) {
	if (remaining.length > 0) {
		console.error(`${remaining.length} files still use an Oh My Pi state name:\n${remaining.join("\n")}`);
		console.error("\nRun: bun scripts/scient/rename-identity.ts");
		process.exit(1);
	}
	console.log("No Oh My Pi state names remain.");
} else {
	console.log(`Renamed Oh My Pi state names in ${changed} files.`);
	// The new names are longer, so some lines need rewrapping.
	if (changed > 0) await $`bun run fmt:tools`.cwd(repoRoot).quiet();
}
