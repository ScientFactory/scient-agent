#!/usr/bin/env bun
/**
 * Checks that every way Scient Agent differs from the Oh My Pi release it is
 * built from is accounted for in scripts/scient/divergences.json:
 *
 * - a file Scient adds is owned by a ledger entry;
 * - a hand-written change to an Oh My Pi file sits inside a marker block
 *   (`scient(ID): begin - why` ... `scient(ID): end`) of an active entry that
 *   lists the file, or is a registered JSON pointer, deletion or unmarked file
 *   (binary, mode and link changes count as unmarked); what it adds and what
 *   it removes are each accounted for, and returning code to Oh My Pi's needs
 *   no marker;
 * - a commit that says it is generated (`Scient-Generator: identity`,
 *   `wording` or `rpc`) is exactly what that generator produces from its
 *   parent, and generated RPC clients change only in such a commit.
 *
 * Each commit is judged by the ledger it carries. It checks provenance and
 * coverage, and coverage is by place: where blocks sit side by side, which of
 * them explains which removed line is left to review. A removal right beside a
 * line Scient changed without a marker (a generated line) cannot be told from a
 * deletion and is flagged; retire such a hook at the next alignment by leaving
 * its contract out of the replay. It does not show that a change is minimal,
 * correct or safe.
 *
 *   bun scripts/scient/divergence-check.ts
 *       Commits on HEAD after the accepted alignment. The annotated tag
 *       omp-sync/v<scient.json upstream version> records it in a
 *       `Scient-Checkpoint: <commit>` line; that commit's tree equals the
 *       tagged replay's. Changes before it were accepted with the alignment.
 *
 *   bun scripts/scient/divergence-check.ts --replay <ref>
 *       An alignment pull request: every commit of the replay <ref> on top of
 *       the upstream commit in scient.json, and HEAD's tree equal to it.
 *
 * The upstream commit must be present: fetch the omp-sync tags or the replay
 * branch with full history first.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { activeEntries, type Ledger, type LedgerEntry, ownersOf, parseLedger } from "./lib/ledger";
import { blockAt, type MarkerBlock, markerSyntaxes, scanMarkers } from "./lib/markers";

const LEDGER = "scripts/scient/divergences.json";
interface Generator {
	command: string[];
	/** Relative to the repository root. */
	cwd?: string;
}
/** The only programs the check runs, besides dependency installation without scripts. */
const GENERATORS: Record<string, Generator> = {
	identity: { command: ["bun", "scripts/scient/rename-identity.ts"] },
	wording: { command: ["bun", "scripts/scient/rename-wording.ts"] },
	// The script itself, not `bun run gen:rpc`, so no package-script hook runs.
	rpc: { command: ["bun", "scripts/gen-rpc/index.ts"], cwd: "packages/coding-agent" },
};
/** Generated RPC clients: they change only in an rpc generated commit. */
const RPC_OUTPUTS = new Set([
	"packages/coding-agent/src/modes/rpc/wire/rpc-wire.schema.json",
	"packages/coding-agent/src/modes/rpc/wire/rpc-wire.generated.ts",
	"sdk/python/omp-rpc/src/omp_rpc/_wire.py",
	"sdk/rust/omp-rpc/src/wire.rs",
	"sdk/go/omp-rpc/wire.go",
]);
/** Where the clients are generated from: a change there is checked by regeneration. */
const RPC_SOURCES = ["packages/coding-agent/src/modes/rpc/wire/", "packages/coding-agent/scripts/gen-rpc/"];
const isRpcPath = (file: string) => RPC_OUTPUTS.has(file) || RPC_SOURCES.some(dir => file.startsWith(dir));
const REGULAR = new Set(["100644", "100755"]);

export interface CheckOptions {
	repo: string;
	head?: string;
	replay?: string;
	/** Run generators to check generated commits. Tests turn this off. */
	regenerate?: boolean;
	/** Check that the RPC wire artifacts match their sources. Fixtures without gen-rpc turn this off. */
	checkRpc?: boolean;
	log?: (line: string) => void;
}

export interface CheckResult {
	problems: string[];
	commits: number;
	generated: number;
	markedFiles: number;
}

class Git {
	constructor(readonly repo: string) {}
	run(args: string[], options: { allowFailure?: boolean } = {}): string {
		const result = Bun.spawnSync(["git", "-C", this.repo, ...args], { stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0 && !options.allowFailure) {
			throw new Error(`git ${args.join(" ")}: ${result.stderr.toString().trim()}`);
		}
		return result.exitCode === 0 ? result.stdout.toString() : "";
	}
	lines(args: string[]): string[] {
		return this.run(args).split("\n").filter(Boolean);
	}
	/** NUL-separated output, so any file name survives. */
	fields(args: string[]): string[] {
		return this.run(args).split("\0").filter(Boolean);
	}
	exists(rev: string): boolean {
		return (
			Bun.spawnSync(["git", "-C", this.repo, "cat-file", "-e", rev], { stdout: "ignore", stderr: "ignore" })
				.exitCode === 0
		);
	}
	show(rev: string, file: string): string | undefined {
		return this.exists(`${rev}:${file}`) ? this.run(["show", `${rev}:${file}`]) : undefined;
	}
	/** Stores text as a blob, so it can be compared like a committed file, and returns its id. */
	blob(text: string): string {
		const result = Bun.spawnSync(["git", "-C", this.repo, "hash-object", "-w", "--stdin"], {
			stdin: new TextEncoder().encode(text),
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) throw new Error(`git hash-object: ${result.stderr.toString().trim()}`);
		return result.stdout.toString().trim();
	}
	tree(rev: string): string {
		return this.run(["rev-parse", `${rev}^{tree}`]).trim();
	}
	files(rev: string): Set<string> {
		return new Set(this.fields(["ls-tree", "-r", "-z", "--name-only", rev]));
	}
}

interface Change {
	status: string;
	oldMode: string;
	newMode: string;
	oldPath: string;
	newPath: string;
}

function changesOf(git: Git, parent: string, commit: string): Change[] {
	const fields = git.fields(["diff-tree", "-r", "-z", "--raw", "-M", "--no-commit-id", parent, commit]);
	const changes: Change[] = [];
	for (let i = 0; i < fields.length; i++) {
		const [oldMode, newMode, , , status] = fields[i].replace(/^:/, "").split(" ");
		const renamed = status.startsWith("R") || status.startsWith("C");
		const oldPath = fields[++i];
		const newPath = renamed ? fields[++i] : oldPath;
		changes.push({ status: status[0], oldMode, newMode, oldPath, newPath });
	}
	return changes;
}

export async function checkDivergence(options: CheckOptions): Promise<CheckResult> {
	const git = new Git(options.repo);
	const head = git.run(["rev-parse", options.head ?? "HEAD"]).trim();
	const log = options.log ?? (() => {});
	const problems: string[] = [];

	const scient = JSON.parse(git.show(head, "scient.json") ?? "{}") as {
		upstream?: { version?: string; commit?: string };
	};
	const upstream = scient.upstream?.commit;
	if (!upstream || !scient.upstream?.version) return fail("scient.json names no upstream version and commit");
	if (!git.exists(`${upstream}^{commit}`)) {
		return fail(
			`upstream commit ${upstream} is not in this clone; fetch the replay tags or branch with full history`,
		);
	}
	const ledgers = new LedgerHistory(git, head);
	const headLedger = ledgers.at(head);
	if (typeof headLedger === "string") return fail(headLedger);
	const upstreamFiles = git.files(upstream);

	let commits: string[];
	const replayMode = options.replay !== undefined;
	if (replayMode) {
		const replay = git.run(["rev-parse", `${options.replay}^{commit}`]).trim();
		if (!isAncestor(git, upstream, replay))
			problems.push(`replay ${options.replay} is not built on upstream ${upstream}`);
		if (git.tree(replay) !== git.tree(head)) {
			problems.push(`HEAD's tree differs from replay ${options.replay}; import the replay's tree exactly`);
		}
		commits = git.lines(["rev-list", "--reverse", `${upstream}..${replay}`]);
	} else {
		const tag = `omp-sync/v${scient.upstream.version}`;
		const checkpoint = acceptedCheckpoint(git, tag, head);
		if (checkpoint.problem) return fail(checkpoint.problem);
		log(`accepted alignment: ${tag} = ${checkpoint.commit.slice(0, 12)}`);
		commits = git.lines(["rev-list", "--reverse", `${checkpoint.commit}..${head}`]);
	}

	let generated = 0;
	let touchesRpc = false;
	let workspace: Workspace | undefined;
	try {
		for (const commit of commits) {
			const parents = git.run(["rev-list", "--parents", "-n", "1", commit]).trim().split(" ").slice(1);
			const subject = git.run(["log", "-1", "--format=%s", commit]).trim();
			const where = `${commit.slice(0, 12)} ${subject}`;
			if (parents.length !== 1) {
				problems.push(`${where}: a merge commit; Scient's history is linear`);
				continue;
			}
			const changes = changesOf(git, parents[0], commit);
			// A rename counts at both ends: moving a client away changes it as much as editing it.
			if (changes.some(change => isRpcPath(change.oldPath) || isRpcPath(change.newPath))) touchesRpc = true;
			const generator = trailer(git, commit, "Scient-Generator");
			if (generator.length > 0) {
				generated++;
				if (generator.length !== 1 || !GENERATORS[generator[0]]) {
					problems.push(`${where}: Scient-Generator names one of ${Object.keys(GENERATORS).join(", ")}`);
					continue;
				}
				if (options.regenerate !== false) {
					workspace ??= new Workspace(git);
					const result = await workspace.regenerate(parents[0], generator[0]);
					if (result.problem) problems.push(`${where}: ${result.problem}`);
					else if (result.tree !== git.tree(commit)) {
						problems.push(
							`${where}: is not exactly the output of the ${generator[0]} generator:\n${result.stat}`,
						);
					}
				}
				continue;
			}
			const now = ledgers.at(commit);
			if (typeof now === "string") {
				problems.push(`${where}: ${now}`);
				continue;
			}
			const declared = trailer(git, commit, "Scient-Divergence");
			if (replayMode && declared.length === 0)
				problems.push(`${where}: names no Scient-Divergence or Scient-Generator`);
			for (const id of declared)
				if (!now.entries[id]) problems.push(`${where}: Scient-Divergence ${id} is not in the ledger`);
			const context: EditContext = {
				git,
				now,
				upstreamFiles,
				upstream,
				parent: parents[0],
				commit,
				where,
				declared: replayMode ? declared : undefined,
			};
			for (const change of changes) problems.push(...checkChange(context, change));
			const before = ledgers.own(parents[0]);
			if (typeof before === "object") problems.push(...checkDroppedCoverage(context, before));
		}
		if (options.regenerate !== false && options.checkRpc !== false && (replayMode || touchesRpc)) {
			// Generated RPC clients must match their final sources.
			workspace ??= new Workspace(git);
			const result = await workspace.regenerate(head, "rpc");
			if (result.problem) problems.push(`RPC wire artifacts: ${result.problem}`);
			else if (result.tree !== git.tree(head)) {
				problems.push(`the RPC wire artifacts are stale; run bun run gen:rpc:\n${result.stat}`);
			}
		}
	} finally {
		workspace?.dispose();
	}

	const inventory = checkInventory(git, headLedger, upstreamFiles, upstream, head);
	problems.push(...inventory.problems);
	return { problems, commits: commits.length, generated, markedFiles: inventory.markedFiles };

	function fail(message: string): CheckResult {
		return { problems: [message], commits: 0, generated: 0, markedFiles: 0 };
	}
}

/** The owned commit an alignment was accepted at, as its annotated tag records it. */
function acceptedCheckpoint(git: Git, tag: string, head: string): { commit: string; problem?: string } {
	const ref = `refs/tags/${tag}`;
	const problem = (message: string) => ({ commit: "", problem: message });
	if (!git.exists(ref)) return problem(`tag ${tag} is missing; fetch the omp-sync tags`);
	if (git.run(["cat-file", "-t", ref]).trim() !== "tag") return problem(`tag ${tag} is not annotated`);
	const message = git.run(["for-each-ref", "--format=%(contents)", ref]);
	const commit = /^Scient-Checkpoint:\s*([0-9a-f]{40})\s*$/m.exec(message)?.[1];
	if (!commit) return problem(`tag ${tag} records no "Scient-Checkpoint: <commit>" line`);
	if (!git.exists(`${commit}^{commit}`)) return problem(`checkpoint ${commit} of ${tag} is not in this clone`);
	if (git.tree(commit) !== git.tree(ref)) return problem(`checkpoint ${commit} does not have the tree of ${tag}`);
	if (!isAncestor(git, commit, head)) return problem(`checkpoint ${commit} of ${tag} is not in HEAD's history`);
	return { commit };
}

function isAncestor(git: Git, ancestor: string, descendant: string): boolean {
	return Bun.spawnSync(["git", "-C", git.repo, "merge-base", "--is-ancestor", ancestor, descendant]).exitCode === 0;
}

function trailer(git: Git, commit: string, key: string): string[] {
	return git
		.run(["log", "-1", `--format=%(trailers:key=${key},valueonly,separator=%x2C)`, commit])
		.split(",")
		.map(value => value.trim())
		.filter(Boolean);
}

/** The ledger each commit carries; a commit without one is judged by HEAD's. */
class LedgerHistory {
	#byBlob = new Map<string, Ledger | string>();
	constructor(
		readonly git: Git,
		readonly head: string,
	) {}
	at(rev: string): Ledger | string {
		return this.own(rev) ?? (rev === this.head ? `${LEDGER} is missing` : this.at(this.head));
	}
	/** The ledger a commit itself carries, if any; a string when it is invalid. */
	own(rev: string): Ledger | string | undefined {
		const blob = this.git.run(["rev-parse", `${rev}:${LEDGER}`], { allowFailure: true }).trim();
		if (!blob) return undefined;
		let ledger = this.#byBlob.get(blob);
		if (ledger === undefined) {
			try {
				ledger = parseLedger(this.git.run(["cat-file", "blob", blob]), LEDGER);
			} catch (error) {
				ledger = (error as Error).message;
			}
			this.#byBlob.set(blob, ledger);
		}
		return ledger;
	}
}

interface EditContext {
	git: Git;
	/** The ledger the commit carries. */
	now: Ledger;
	upstreamFiles: ReadonlySet<string>;
	/** The Oh My Pi commit the tree derives from. */
	upstream: string;
	parent: string;
	commit: string;
	where: string;
	/** In a replay: the ids the commit's Scient-Divergence names. */
	declared?: readonly string[];
}

const isActive = (ledger: Ledger, id: string) => ledger.entries[id]?.status === "active";
const isDeleted = (ledger: Ledger, file: string) =>
	activeEntries(ledger).some(([, entry]) => entry.deleted?.includes(file));
const unmarkedReason = (ledger: Ledger, file: string) =>
	activeEntries(ledger)
		.map(([, entry]) => entry.unmarked?.[file])
		.find(Boolean);

function checkChange(context: EditContext, change: Change): string[] {
	const { now, upstreamFiles, where } = context;
	const problems: string[] = [];
	// Before anything that could accept the change: a generated client changes only by regeneration.
	const client = [change.oldPath, change.newPath].find(file => RPC_OUTPUTS.has(file));
	if (client) return [`${where}: changes the generated ${client}; regenerate it in a Scient-Generator: rpc commit`];
	if (change.status === "D" || change.status === "R") {
		if (upstreamFiles.has(change.oldPath) && !isDeleted(now, change.oldPath)) {
			problems.push(`${where}: removes Oh My Pi's ${change.oldPath}, which no entry lists as deleted`);
		}
		if (change.status === "D") return problems;
	}
	const file = change.newPath;
	if (!upstreamFiles.has(file)) return problems; // A Scient file; the inventory checks its owner.
	if (unmarkedReason(now, file)) return problems;
	if (!REGULAR.has(change.newMode) || (change.oldMode !== change.newMode && change.status !== "A")) {
		problems.push(`${where}: changes the mode or type of Oh My Pi's ${file}; list it as unmarked, with the reason`);
		return problems;
	}
	if (isBinary(context, file)) {
		problems.push(`${where}: changes Oh My Pi's binary ${file}; list it as unmarked, with the reason`);
		return problems;
	}
	if (file.endsWith(".json")) return [...problems, ...checkJsonEdit(context, file)];
	if (!markerSyntaxes(file)) {
		problems.push(
			`${where}: changes Oh My Pi's ${file}, which cannot hold a marker; list it as unmarked, with the reason`,
		);
		return problems;
	}
	return [...problems, ...checkMarkedEdit(context, file)];
}

/**
 * What a commit's ledger stops covering: an unmarked file or a JSON pointer
 * its parent's ledger registered and its own does not. The commit may leave
 * the file alone, so the file is checked as it now stands against Oh My Pi's:
 * it must be Oh My Pi's again there, or covered another way.
 */
function checkDroppedCoverage(context: EditContext, before: Ledger): string[] {
	const { git, now, upstream, commit, where } = context;
	const problems: string[] = [];
	for (const [, entry] of activeEntries(before)) {
		for (const file of Object.keys(entry.unmarked ?? {})) {
			const current = treeEntry(git, commit, file);
			const original = treeEntry(git, upstream, file);
			// A removed file is a deletion, which the inventory checks.
			if (unmarkedReason(now, file) || !current || !original || current === original) continue;
			const [oldMode, newMode] = [original, current].map(found => found.split(" ")[0]);
			const asIfChanged: EditContext = {
				...context,
				parent: upstream,
				where: `${where} (drops the unmarked registration of ${file})`,
				declared: undefined,
			};
			problems.push(...checkChange(asIfChanged, { status: "M", oldMode, newMode, oldPath: file, newPath: file }));
		}
		for (const [file, pointers] of Object.entries(entry.json ?? {})) {
			const registered = activeEntries(now).flatMap(([, other]) => other.json?.[file] ?? []);
			const covered = (pointer: string) =>
				registered.some(prefix => pointer === prefix || pointer.startsWith(`${prefix}/`));
			const current = git.show(commit, file);
			// A whole-file registration now covers every pointer.
			if (current === undefined || unmarkedReason(now, file) || pointers.every(covered)) continue;
			let currentValue: unknown;
			let upstreamValue: unknown;
			try {
				currentValue = JSON.parse(current);
				upstreamValue = JSON.parse(git.show(upstream, file) ?? "null");
			} catch {
				problems.push(`${where}: ${file} is not valid JSON; list it as unmarked, with the reason`);
				continue;
			}
			for (const pointer of pointers.filter(pointer => !covered(pointer))) {
				const differs = changedPointers(valueAt(upstreamValue, pointer), valueAt(currentValue, pointer), pointer);
				const uncovered = differs.find(changed => !covered(changed));
				if (uncovered !== undefined) {
					problems.push(
						`${where}: drops the registration of ${file} ${pointer}, but ${uncovered || "/"} still differs from Oh My Pi`,
					);
				}
			}
		}
	}
	return problems;
}

/** A file's `<mode> <type> <object>` in a commit's tree, or undefined. */
function treeEntry(git: Git, rev: string, file: string): string | undefined {
	return git.fields(["ls-tree", "-z", rev, "--", file])[0]?.split("\t")[0];
}

function isBinary({ git, parent, commit }: EditContext, file: string): boolean {
	return git.run(["diff", "--numstat", "--no-renames", parent, commit, "--", file]).startsWith("-\t-\t");
}

interface Hunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
}

/** Line differences between two commits' copies of a file, or, with no file, between two blobs. */
function hunksOf(git: Git, from: string, to: string, file?: string): Hunk[] {
	const diff = git.run([
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		"--no-renames",
		"--unified=0",
		from,
		to,
		...(file === undefined ? [] : ["--", file]),
	]);
	return [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(match => ({
		oldStart: Number(match[1]),
		oldCount: match[2] === undefined ? 1 : Number(match[2]),
		newStart: Number(match[3]),
		newCount: match[4] === undefined ? 1 : Number(match[4]),
	}));
}

function checkMarkedEdit(context: EditContext, file: string): string[] {
	const { git, now, parent, commit, where, declared } = context;
	const text = git.show(commit, file) ?? "";
	const result = scanMarkers(file, text);
	const problems = result.errors.map(error => `${where}: ${error}`);
	const hunks = hunksOf(git, parent, commit, file);
	// Where the file's code outside blocks differs from Oh My Pi's. A block's
	// content is left out, so a copy of Oh My Pi's lines inside a block never
	// stands in for them; each block becomes a gap between the lines around it.
	const outside = outsideBlocks(text, result.blocks);
	const differences = hunksOf(git, `${context.upstream}:${file}`, git.blob(outside.text));
	const isUpstreamLine = (line: number) => {
		const kept = outside.indexOf.get(line);
		return kept !== undefined && !differences.some(d => d.newStart <= kept && kept < d.newStart + d.newCount);
	};
	if (hunks.length === 0) {
		problems.push(`${where}: ${file} changed with no line differences Git can show; list it as unmarked`);
		return problems;
	}
	const used = new Set<string>();
	for (const hunk of hunks) {
		// What the commit adds: lines inside a block, or Oh My Pi's own lines.
		for (let line = hunk.newStart; line < hunk.newStart + hunk.newCount; line++) {
			const block = blockAt(result.blocks, line);
			if (block) used.add(block.id);
			else if (!isUpstreamLine(line)) {
				problems.push(`${where}: ${file}:${line} changes Oh My Pi's code outside a scient(ID) block`);
				break;
			}
		}
		// What it removes, judged apart from what it adds: wherever Oh My Pi's lines
		// are missing at the removal, a block must sit there to explain them. With
		// none missing, the removal restored Oh My Pi's code; retiring a block that
		// replaced Oh My Pi's lines therefore means restoring them.
		if (hunk.oldCount === 0) continue;
		const [from, to] = siteOf(hunk);
		for (const [low, high] of missingAt(differences, outside, hunk)) {
			// A block in that place that also touches the removal itself: Git may
			// group a deletion with an unrelated change near another block.
			const block = result.blocks.find(
				candidate =>
					low < candidate.begin &&
					candidate.end < high &&
					2 * candidate.begin - 1 <= to &&
					from <= 2 * candidate.end + 1,
			);
			if (block) used.add(block.id);
			else {
				problems.push(`${where}: ${file}:${hunk.newStart} removes Oh My Pi's lines with no scient(ID) block there`);
				break;
			}
		}
	}
	for (const id of used) {
		const entry = now.entries[id];
		if (!entry || entry.status !== "active") {
			problems.push(`${where}: ${file} uses marker ${id}, which is not an active ledger entry`);
		} else if (!entry.upstream?.includes(file)) {
			problems.push(`${where}: ${file} carries ${id} markers but ${id} does not list it`);
		}
		if (declared && !declared.includes(id)) {
			problems.push(`${where}: ${file} uses ${id}, which the commit's Scient-Divergence does not name`);
		}
	}
	return problems;
}

/**
 * Where a hunk's removed lines were, on a doubled scale (line n is 2n, the gap
 * after it 2n + 1): its new lines with the gaps either side, or the gap it left.
 */
function siteOf(hunk: Hunk): [number, number] {
	return hunk.newCount === 0
		? [2 * hunk.newStart + 1, 2 * hunk.newStart + 1]
		: [2 * hunk.newStart - 1, 2 * (hunk.newStart + hunk.newCount) - 1];
}

/** A file's lines outside its blocks, and where each of them is in the file. */
interface OutsideBlocks {
	text: string;
	/** The file line (1-based) of each kept line, in order. */
	lines: number[];
	/** A file line's number among the kept lines. */
	indexOf: Map<number, number>;
	/** How many lines the file has. */
	total: number;
}

function outsideBlocks(text: string, blocks: readonly MarkerBlock[]): OutsideBlocks {
	// Lines keep their own endings, so the kept text compares with Oh My Pi's byte for byte.
	const pieces = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
	const kept: string[] = [];
	const lines: number[] = [];
	const indexOf = new Map<number, number>();
	pieces.forEach((piece, index) => {
		if (blockAt(blocks, index + 1)) return;
		kept.push(piece);
		lines.push(index + 1);
		indexOf.set(index + 1, lines.length);
	});
	return { text: kept.join(""), lines, indexOf, total: pieces.length };
}

/**
 * Where Oh My Pi's lines are missing at a hunk's removal, each as the open
 * range of file lines between the kept lines around it; a block inside that
 * range sits where they were. A deletion leaves its gap. A replacement leaves
 * its lines and the gaps either side, as Git may put lost lines next to the
 * lines that replaced them. A place counts when it meets the removal's site.
 */
function missingAt(differences: readonly Hunk[], outside: OutsideBlocks, hunk: Hunk): Array<[number, number]> {
	// The file line of kept line j: 0 before the first, past the end after the last.
	const fileLine = (j: number) => (j < 1 ? 0 : j > outside.lines.length ? outside.total + 1 : outside.lines[j - 1]);
	const [from, to] = siteOf(hunk);
	return differences
		.filter(difference => difference.oldCount > 0) // An insertion leaves nothing missing.
		.map(({ newStart, newCount }): [number, number] =>
			newCount === 0
				? [fileLine(newStart), fileLine(newStart + 1)]
				: [fileLine(newStart - 1), fileLine(newStart + newCount)],
		)
		.filter(([low, high]) => 2 * low + 1 <= to && from <= 2 * high - 1);
}

function checkJsonEdit({ git, now, upstream, parent, commit, where }: EditContext, file: string): string[] {
	let oldValue: unknown;
	let newValue: unknown;
	let upstreamValue: unknown;
	try {
		oldValue = JSON.parse(git.show(parent, file) ?? "null");
		newValue = JSON.parse(git.show(commit, file) ?? "null");
		upstreamValue = JSON.parse(git.show(upstream, file) ?? "null");
	} catch {
		return [`${where}: ${file} is not valid JSON; list it as unmarked, with the reason`];
	}
	const registered = activeEntries(now).flatMap(([, entry]) => entry.json?.[file] ?? []);
	return (
		changedPointers(oldValue, newValue)
			.filter(pointer => !registered.some(prefix => pointer === prefix || pointer.startsWith(`${prefix}/`)))
			// A value returned to Oh My Pi's is not a divergence: retiring a registration restores it.
			.filter(
				pointer => JSON.stringify(valueAt(newValue, pointer)) !== JSON.stringify(valueAt(upstreamValue, pointer)),
			)
			.map(pointer => `${where}: ${file} changes ${pointer || "/"}, which no entry registers`)
	);
}

/** The value a JSON pointer (RFC 6901) names, or undefined. */
function valueAt(value: unknown, pointer: string): unknown {
	let current = value;
	for (const token of pointer.split("/").slice(1)) {
		const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
		if (typeof current !== "object" || current === null || !Object.hasOwn(current, key)) return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

/** JSON pointers (RFC 6901) of every value that differs. */
export function changedPointers(before: unknown, after: unknown, at = ""): string[] {
	const record = (v: unknown): v is Record<string, unknown> =>
		typeof v === "object" && v !== null && !Array.isArray(v);
	if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
		return before.flatMap((value, index) => changedPointers(value, after[index], `${at}/${index}`));
	}
	if (record(before) && record(after)) {
		const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
		return [...keys].flatMap(key =>
			changedPointers(before[key], after[key], `${at}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`),
		);
	}
	return JSON.stringify(before) === JSON.stringify(after) ? [] : [at];
}

/** At HEAD: every file Scient adds has an owner, every marker names an active entry that lists its file. */
function checkInventory(
	git: Git,
	ledger: Ledger,
	upstreamFiles: ReadonlySet<string>,
	upstream: string,
	head: string,
): { problems: string[]; markedFiles: number } {
	const problems: string[] = [];
	const headFiles = git.files(head);
	for (const file of headFiles) {
		if (!upstreamFiles.has(file) && ownersOf(ledger, file).length === 0) {
			problems.push(`${file}: added by Scient but owned by no entry`);
		}
	}
	for (const file of upstreamFiles) {
		if (!headFiles.has(file) && !isDeleted(ledger, file)) {
			problems.push(`${file}: Oh My Pi's file is gone, but no entry lists it as deleted`);
		}
	}
	const markers = new Map<string, Set<string>>();
	const changed = git
		.fields(["diff", "-z", "--name-only", "--no-renames", upstream, head])
		.filter(file => upstreamFiles.has(file) && headFiles.has(file));
	for (const file of changed) {
		if (!markerSyntaxes(file)) continue;
		const { blocks, errors } = scanMarkers(file, git.show(head, file) ?? "");
		problems.push(...errors);
		for (const block of blocks) {
			if (!isActive(ledger, block.id))
				problems.push(`${file}:${block.begin}: marker ${block.id} is not an active ledger entry`);
			const files = markers.get(block.id) ?? new Set<string>();
			files.add(file);
			markers.set(block.id, files);
		}
	}
	for (const [id, entry] of activeEntries(ledger)) {
		for (const file of entry.upstream ?? []) {
			if (!upstreamFiles.has(file)) problems.push(`${id}: lists ${file}, which Oh My Pi does not have`);
			else if (!markers.get(id)?.has(file)) problems.push(`${id}: lists ${file}, which carries no ${id} marker`);
		}
		for (const file of Object.keys(entry.json ?? {})) {
			if (!headFiles.has(file)) problems.push(`${id}: registers JSON pointers in ${file}, which does not exist`);
		}
		for (const file of [...(entry.deleted ?? []), ...Object.keys(entry.unmarked ?? {})]) {
			if (!upstreamFiles.has(file)) problems.push(`${id}: lists ${file}, which Oh My Pi does not have`);
		}
		if (!hasEffect(entry))
			problems.push(`${id}: an active entry with nothing registered; mark it retired or upstreamed`);
	}
	for (const [id, files] of markers) {
		for (const file of files) {
			if (isActive(ledger, id) && !ledger.entries[id].upstream?.includes(file)) {
				problems.push(`${file}: carries ${id} markers, but ${id} does not list it`);
			}
		}
	}
	return { problems, markedFiles: [...markers.values()].reduce((sum, files) => sum + files.size, 0) };
}

function hasEffect(entry: LedgerEntry): boolean {
	return Boolean(
		entry.owned?.length ||
		entry.upstream?.length ||
		Object.keys(entry.json ?? {}).length ||
		entry.deleted?.length ||
		Object.keys(entry.unmarked ?? {}).length,
	);
}

/** A disposable worktree where generators run against a commit's parent. */
class Workspace {
	readonly dir: string;
	#installedLock: string | undefined;
	constructor(readonly git: Git) {
		this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "scient-divergence-"));
		fs.rmSync(this.dir, { recursive: true, force: true });
		git.run(["worktree", "add", "--detach", this.dir, "HEAD"]);
	}
	async regenerate(base: string, name: string): Promise<{ tree: string; stat: string; problem?: string }> {
		const work = new Git(this.dir);
		work.run(["checkout", "--quiet", "--force", "--detach", base]);
		work.run(["clean", "-fdq", "-e", "node_modules"]);
		// A tree without a lockfile (a test fixture) has nothing to install.
		const lock = work.run(["rev-parse", `${base}:bun.lock`], { allowFailure: true }).trim();
		if (lock && lock !== this.#installedLock) {
			// No lifecycle scripts: only the declared generator may change the tree.
			await run(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], this.dir);
			this.#installedLock = lock;
		}
		if (work.run(["status", "--porcelain", "--untracked-files=no"]).trim()) {
			return { tree: "", stat: "", problem: "installing dependencies changed tracked files" };
		}
		const generator = GENERATORS[name];
		await run(generator.command, path.join(this.dir, generator.cwd ?? ""));
		work.run(["add", "-A"]);
		return { tree: work.run(["write-tree"]).trim(), stat: work.run(["diff", "--cached", "--stat", base]) };
	}
	dispose(): void {
		this.git.run(["worktree", "remove", "--force", this.dir], { allowFailure: true });
	}
}

async function run(command: string[], cwd: string): Promise<void> {
	const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`${command.join(" ")} failed in ${cwd}:\n${stdout}${stderr}`);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const value = (flag: string) => {
		const index = args.indexOf(flag);
		return index === -1 ? undefined : args[index + 1];
	};
	const repo = path.resolve(import.meta.dir, "..", "..");
	const result = await checkDivergence({
		repo,
		head: value("--head"),
		replay: value("--replay"),
		log: line => console.log(line),
	});
	console.log(
		`${result.commits} commits checked (${result.generated} generated); marker blocks in ${result.markedFiles} Oh My Pi files.`,
	);
	if (result.problems.length > 0) {
		console.error(
			`\n${result.problems.length} problems:\n${result.problems.map(problem => `- ${problem}`).join("\n")}`,
		);
		process.exit(1);
	}
	console.log("Every divergence is accounted for.");
}
