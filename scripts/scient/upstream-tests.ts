#!/usr/bin/env bun
/**
 * Runs one of Oh My Pi's CI test buckets with upstream's runner, unchanged
 * (`scripts/ci-test-ts.ts <mode> --full`), and lets it fail only for a reason
 * that is Scient's to fix.
 *
 * A failed bucket passes only when every failure is one `KNOWN_FAILURES` lists
 * for the exact Oh My Pi commit `scient.json` names: a test that fails on that
 * commit untouched, on the runner this workflow uses. The entries lapse at the
 * next alignment, which checks them again. Anything else fails the run: an
 * unlisted test, a chunk that crashed or was killed, an error outside any test,
 * and a report this cannot reconcile in full.
 *
 * `--full` makes the runner print each chunk's whole Bun output, so Bun's own
 * counts can be checked against the failures it names. Its quiet report lists
 * only the failures it can attribute and may leave out an error that a test
 * file threw while loading. `--full` changes what is printed, not what runs.
 *
 *   bun scripts/scient/upstream-tests.ts <mode>
 */
import * as path from "node:path";

/** A test that fails on untouched Oh My Pi at `commit`, with the evidence. */
interface KnownFailure {
	commit: string;
	/** `<package>/<test file> > <describe> > <test>`. */
	test: string;
	evidence: string;
}

// Each was seen failing on untouched 18.12.1 on ubuntu-22.04 (2026-10-18), in
// 16 coding-agent-native or 3 coding-agent-ui bucket runs; SCIENT.md, "Fourth
// alignment intake", has the counts.
const KNOWN_FAILURES: KnownFailure[] = [
	{
		commit: "291e055836c210f314af3f73f53244e8e9d09de8",
		test: "packages/coding-agent/test/tools/browser-tab-worker-startup.test.ts > browser tabs whose renderer crashed > cancels an inline worker's run whose renderer crashed instead of letting it go on after its caller was told",
		evidence:
			"Failed in 13 of 16 bucket runs untouched; on 18.11.3, 7 of 8 untouched and 7 of 8 on Scient's tree with identical chunks.",
	},
	{
		commit: "291e055836c210f314af3f73f53244e8e9d09de8",
		test: "packages/coding-agent/test/tools/browser-relay-detach.test.ts > relay tabs Chrome detaches Scient Agent from > does not rerun a call detached before its code started once the re-adoption spent its budget",
		evidence:
			"Failed in 5 of 16 bucket runs untouched; on 18.11.3, 3 of 8 untouched and 2 of 8 on Scient's tree with identical chunks.",
	},
	{
		commit: "291e055836c210f314af3f73f53244e8e9d09de8",
		test: "packages/coding-agent/test/tools/browser-tab-worker-startup.test.ts > browser tabs whose renderer crashed > closes a reattached headless tab's page when the tab is released",
		evidence: "Failed in 2 of 16 bucket runs untouched, and once in the v0.1.1 tag's CI run.",
	},
	{
		commit: "291e055836c210f314af3f73f53244e8e9d09de8",
		test: "packages/coding-agent/test/tools/browser-nav-frames-dialogs.test.ts > browser navigation, frames, dialogs, and tab listing > does not call a cancelled run's page listeners for the requests the cancel stops",
		evidence: "Failed in 1 of 16 bucket runs untouched, at its 30-second timeout.",
	},
	{
		commit: "291e055836c210f314af3f73f53244e8e9d09de8",
		test: "packages/coding-agent/test/tools.test.ts > Coding Agent Tools > read tool > re-reads an archive rewritten in place with the same size and restored mtime",
		evidence:
			"Failed in 5 of 16 bucket runs untouched. Consistent with its archive cache keying on ctime, which Linux advances in coarse ticks.",
	},
	{
		commit: "291e055836c210f314af3f73f53244e8e9d09de8",
		test: "packages/coding-agent/test/status-line-vcs-refresh.test.ts > StatusLineComponent git watcher survives atomic HEAD renames > keeps firing #onBranchChange across consecutive branch switches",
		evidence:
			"Failed in 1 of 16 bucket runs untouched, at its 30-second timeout; it failed the same way once in Scient's CI for 18.11.3.",
	},
	{
		commit: "291e055836c210f314af3f73f53244e8e9d09de8",
		test: "packages/coding-agent/test/agent-hub-ordering.test.ts > Agent hub row ordering > renders parent lineage with bash-style tree connectors",
		evidence:
			"Failed in 1 of 3 coding-agent-ui bucket runs untouched: a child row drew as the last child instead of the first.",
	},
];

/** Why a bucket's failure is or is not acceptable. */
export interface Judgement {
	/** Known failures that occurred; the run passes when `problems` is empty. */
	known: string[];
	problems: string[];
}

const CHUNK_HEADER = /^==> \[\d+\/\d+\] (.+) \((?:ok|FAILED exit (\d+)), [\d.]+s\)$/;
const FAILED_FOOTER = /^(\d+) of \d+ test chunk\(s\) FAILED$/;

/**
 * Judges a failed `ci-test-ts.ts <mode> --full` run from its exit code and
 * output: a `==> [i/n] <label> (FAILED exit N, …)` block per failed chunk with
 * Bun's whole output, and a `N of M test chunk(s) FAILED` footer.
 */
export function judge(exitCode: number, output: string, known: ReadonlySet<string>): Judgement {
	const problems: string[] = [];
	const seen: string[] = [];
	if (exitCode !== 1) problems.push(`the runner exited ${exitCode}, not with failed tests`);
	const lines = output.split(/\r?\n/);
	const failed = Number(lines.map(line => FAILED_FOOTER.exec(line)?.[1]).find(Boolean) ?? 0);
	if (failed === 0) problems.push("the runner printed no failure summary");

	let chunks = 0;
	for (let start = 0; start < lines.length; start++) {
		const header = CHUNK_HEADER.exec(lines[start]);
		if (!header?.[2]) continue;
		chunks++;
		let end = start + 1;
		while (end < lines.length && !CHUNK_HEADER.test(lines[end]) && !FAILED_FOOTER.test(lines[end])) end++;
		problems.push(...judgeChunk(header[1], Number(header[2]), lines.slice(start + 1, end), known, seen));
		start = end - 1;
	}
	if (chunks !== failed) problems.push(`the runner says ${failed} chunks failed; ${chunks} were reported`);
	return { known: seen, problems };
}

/** The problems with one failed chunk, given Bun's whole output for it. */
function judgeChunk(
	label: string,
	exit: number,
	lines: string[],
	known: ReadonlySet<string>,
	seen: string[],
): string[] {
	if (exit !== 1) return [`${label}: exited ${exit}, not with failed tests`];
	const problems: string[] = [];
	const pkg = label.split(" ")[0];
	const failures: string[] = [];
	let file: string | undefined;
	let failCount: number | undefined;
	let finished = false;
	let recap = false;
	for (const raw of lines) {
		const line = raw.trim();
		if (line.startsWith("# Unhandled error")) problems.push(`${label}: an error outside any test`);
		const errors = /^(\d+) errors?$/.exec(line);
		if (errors && errors[1] !== "0") problems.push(`${label}: Bun counted ${errors[1]} errors outside tests`);
		const fails = /^(\d+) fail$/.exec(line);
		if (fails) failCount = Number(fails[1]);
		if (/^Ran \d+ tests? across \d+ files?\./.test(line)) finished = true;
		// Bun lists the failures again at the end; they are counted where they happened.
		if (/^\d+ tests? failed:$/.test(line)) recap = true;
		const header = /^(\S.*\.test\.[cm]?[jt]sx?):$/.exec(line);
		if (header) file = header[1].replaceAll("\\", "/");
		const marker = /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/.exec(line);
		if (marker && !recap) failures.push(file ? `${pkg}/${file} > ${marker[1]}` : `${pkg}: ${marker[1]}`);
	}
	if (!finished || failCount === undefined) problems.push(`${label}: Bun did not finish its report`);
	else if (failCount !== failures.length) {
		problems.push(`${label}: Bun counted ${failCount} failures and named ${failures.length}`);
	}
	if (failures.length === 0) problems.push(`${label}: failed without naming a test`);
	for (const id of failures) {
		if (known.has(id)) seen.push(id);
		else problems.push(`failed: ${id}`);
	}
	return problems;
}

if (import.meta.main) {
	const mode = process.argv[2];
	if (!mode) {
		console.error("Usage: bun scripts/scient/upstream-tests.ts <mode>");
		process.exit(2);
	}
	const repoRoot = path.resolve(import.meta.dir, "..", "..");
	const runner = ["bun", "scripts/ci-test-ts.ts", mode, "--full"];
	const child = Bun.spawn(runner, { cwd: repoRoot, stdout: "pipe", stderr: "inherit" });
	let output = "";
	const decoder = new TextDecoder();
	for await (const bytes of child.stdout) {
		const text = decoder.decode(bytes, { stream: true });
		output += text;
		process.stdout.write(text);
	}
	const exitCode = await child.exited;
	// The exit code is set, not passed to process.exit(), which would cut off output still on its way to a pipe.
	if (exitCode !== 0) {
		const { upstream } = await Bun.file(path.join(repoRoot, "scient.json")).json();
		const known = new Set(KNOWN_FAILURES.filter(entry => entry.commit === upstream.commit).map(entry => entry.test));
		const { known: seen, problems } = judge(exitCode, output, known);
		for (const id of seen) console.log(`::warning::Fails on untouched Oh My Pi ${upstream.version} too: ${id}`);
		for (const problem of problems) console.log(`::error::${problem}`);
		process.exitCode = problems.length > 0 ? 1 : 0;
	}
}
