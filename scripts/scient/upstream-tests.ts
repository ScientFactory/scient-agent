#!/usr/bin/env bun
/**
 * Runs one of Oh My Pi's CI test buckets with upstream's runner, unchanged
 * (`scripts/ci-test-ts.ts <mode> --full`), and lets it fail only for a reason
 * that is Scient's to fix.
 *
 * A failed bucket passes only when every failure is one `KNOWN_FAILURES` lists
 * for the exact Oh My Pi commit `scient.json` names: a test that fails on that
 * commit untouched, on the runner this workflow uses. The entries lapse at the
 * next alignment, which checks them again. A flaky test can also pass while an
 * unexpired row of `ci-quarantine.json` names it and its failure shows the row's
 * signature; a release run takes no quarantine. Anything else fails the run: an
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
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** A test that fails on untouched Oh My Pi at `commit`, with the evidence. */
interface KnownFailure {
	commit: string;
	/** `<package>/<test file> > <describe> > <test>`. */
	test: string;
	evidence: string;
}

// Seen failing on untouched 18.22.0 on ubuntu-22.04 (2026-11-17), in 8 coding-agent-native and 2 workspace
// bucket runs; SCIENT.md, "Eleventh alignment intake", has the counts.
const KNOWN_FAILURES: KnownFailure[] = [
	{
		commit: "3e8cff3b7ce19a805c11a26a6dd1703066435851",
		test: "packages/coding-agent/test/sdk-tool-activation.test.ts > createAgentSession defaultInactive tool activation > releases a timed-out activation so later lifecycle registrations can proceed",
		evidence: "Failed in 1 of 8 bucket runs untouched, and in 1 of 8 on Scient's replay.",
	},
	{
		commit: "3e8cff3b7ce19a805c11a26a6dd1703066435851",
		test: "packages/coding-agent/test/tools/browser-background-input.test.ts > background tab input > drives an app CDP URL tab in the background",
		evidence: "Failed in 1 of 8 bucket runs untouched, and in none of 8 on Scient's replay.",
	},
	{
		commit: "3e8cff3b7ce19a805c11a26a6dd1703066435851",
		test: "packages/coding-agent/test/tools/browser-nav-frames-dialogs.test.ts > browser navigation, frames, dialogs, and tab listing > does not call a cancelled run's page listeners for the requests the cancel stops",
		evidence: "Failed in 1 of 8 bucket runs untouched, and in none of 8 on Scient's replay.",
	},
	{
		commit: "3e8cff3b7ce19a805c11a26a6dd1703066435851",
		test: "packages/coding-agent/test/tools/read-pdf-screenshot-chromium.test.ts > PDF page screenshots in Chromium > paints each requested image-only page instead of the empty viewer",
		evidence: "Failed in 1 of 8 bucket runs untouched, and in none of 8 on Scient's replay.",
	},
];

/**
 * A flaky test whose failure does not fail the run until `expires`, a week after `quarantined`. Only a failure whose
 * own output contains `signature` matches, so the same test failing another way still blocks.
 */
export interface QuarantineRow {
	id: string;
	/** `<package>/<test file> > <describe> > <test>`. */
	test: string;
	signature: string;
	owner: string;
	/** `YYYY-MM-DD`, UTC. */
	quarantined: string;
	/** `YYYY-MM-DD`, UTC; the row blocks again from the next day. */
	expires: string;
}

/** The rows in force and today's UTC date; a release run passes no rows. */
export interface Quarantine {
	rows: readonly QuarantineRow[];
	today: string;
}

/** A failure a quarantine row let through. */
export interface QuarantinedFailure {
	test: string;
	row: string;
	owner: string;
	expires: string;
}

/** Why a bucket's failure is or is not acceptable. */
export interface Judgement {
	/** Known failures that occurred; the run passes when `problems` is empty. */
	known: string[];
	quarantined: QuarantinedFailure[];
	problems: string[];
}

const NO_QUARANTINE: Quarantine = { rows: [], today: "" };

const DAY_MS = 86_400_000;

/** The UTC midnight a canonical `YYYY-MM-DD` names, or `undefined` for any other spelling. */
function utcDay(value: unknown): number | undefined {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
	const time = Date.parse(`${value}T00:00:00Z`);
	return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value ? undefined : time;
}

/** Whether a row can match at all: canonical dates, expiring no earlier than it started and within a week. */
export function rowIsValid(row: QuarantineRow): boolean {
	const start = utcDay(row.quarantined);
	const end = utcDay(row.expires);
	return (
		start !== undefined &&
		end !== undefined &&
		end >= start &&
		end - start <= 7 * DAY_MS &&
		typeof row.test === "string" &&
		typeof row.signature === "string" &&
		row.signature.trim().length > 0
	);
}

const CHUNK_HEADER = /^==> \[\d+\/\d+\] (.+) \((?:ok|FAILED exit (\d+)), [\d.]+s\)$/;
const FAILED_FOOTER = /^(\d+) of \d+ test chunk\(s\) FAILED$/;

/**
 * Judges a failed `ci-test-ts.ts <mode> --full` run from its exit code and
 * output: a `==> [i/n] <label> (FAILED exit N, …)` block per failed chunk with
 * Bun's whole output, and a `N of M test chunk(s) FAILED` footer.
 */
export function judge(
	exitCode: number,
	output: string,
	known: ReadonlySet<string>,
	quarantine: Quarantine = NO_QUARANTINE,
): Judgement {
	const problems: string[] = [];
	const seen: string[] = [];
	const quarantined: QuarantinedFailure[] = [];
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
		const chunkLines = lines.slice(start + 1, end);
		problems.push(...judgeChunk(header[1], Number(header[2]), chunkLines, known, quarantine, seen, quarantined));
		start = end - 1;
	}
	if (chunks !== failed) problems.push(`the runner says ${failed} chunks failed; ${chunks} were reported`);
	return { known: seen, quarantined, problems };
}

/** The problems with one failed chunk, given Bun's whole output for it. */
function judgeChunk(
	label: string,
	exit: number,
	lines: string[],
	known: ReadonlySet<string>,
	quarantine: Quarantine,
	seen: string[],
	quarantined: QuarantinedFailure[],
): string[] {
	if (exit !== 1) return [`${label}: exited ${exit}, not with failed tests`];
	const problems: string[] = [];
	const pkg = label.split(" ")[0];
	const failures: Array<{ id: string; output: string }> = [];
	// Bun prints a failure's error before its `(fail)` line; these are the lines since the last test or file.
	let block: string[] = [];
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
		if (marker && !recap) {
			const id = file ? `${pkg}/${file} > ${marker[1]}` : `${pkg}: ${marker[1]}`;
			failures.push({ id, output: block.join("\n") });
		}
		if (header || marker || /^\((?:pass|skip|todo)\) /.test(line)) block = [];
		else block.push(raw);
	}
	if (!finished || failCount === undefined) problems.push(`${label}: Bun did not finish its report`);
	else if (failCount !== failures.length) {
		problems.push(`${label}: Bun counted ${failCount} failures and named ${failures.length}`);
	}
	if (failures.length === 0) problems.push(`${label}: failed without naming a test`);
	for (const { id, output } of failures) {
		if (known.has(id)) {
			seen.push(id);
			continue;
		}
		const row = quarantine.rows.find(
			entry =>
				rowIsValid(entry) &&
				entry.test === id &&
				output.includes(entry.signature) &&
				utcDay(quarantine.today) !== undefined &&
				quarantine.today <= entry.expires,
		);
		if (row) quarantined.push({ test: id, row: row.id, owner: row.owner, expires: row.expires });
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
		// A release ships only from a run without a quarantined failure.
		const release = process.env.RELEASE === "true";
		const register = await Bun.file(path.join(import.meta.dir, "ci-quarantine.json")).json();
		const quarantine = { rows: release ? [] : register.rows, today: new Date().toISOString().slice(0, 10) };
		const { known: seen, quarantined, problems } = judge(exitCode, output, known, quarantine);
		for (const id of seen) console.log(`::warning::Fails on untouched Oh My Pi ${upstream.version} too: ${id}`);
		const notes = quarantined.map(
			entry => `Quarantined by \`${entry.row}\` (${entry.owner}, expires ${entry.expires}): ${entry.test}`,
		);
		for (const note of notes) console.log(`::warning::${note}`);
		if (notes.length > 0 && process.env.GITHUB_STEP_SUMMARY) {
			const lines = notes.map(note => `- ${note}`).join("\n");
			await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### Quarantined failures (${mode})\n\n${lines}\n`);
		}
		if (release && problems.length > 0) console.log("::notice::A release run takes no quarantine rows.");
		for (const problem of problems) console.log(`::error::${problem}`);
		process.exitCode = problems.length > 0 ? 1 : 0;
	}
}
