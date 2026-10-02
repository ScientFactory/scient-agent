#!/usr/bin/env bun
/**
 * Makes the agent call itself Scient Agent wherever a person or a model reads
 * its words: messages, help and command descriptions, sign-in instructions,
 * prompts, and the documentation built into the executable.
 *
 * - "Oh My Pi" and "OMP", used as the product's name, become "Scient Agent".
 * - `omp`, used as the command, becomes `scient-agent`; used as the product's
 *   name in a sentence, it becomes "Scient Agent".
 *
 * Only text is changed. In source files that means string literals, the
 * literal parts of template strings and regular expression literals
 * (`lib/text-spans.ts`); identifiers, comments, environment variables, the
 * `omp://` scheme, `.omp-plugin`, package names and anything else written
 * `omp.`, `omp-`, `omp_` or `omp/` are left alone. So is `omp` where it is a
 * value rather than a word of a sentence (`isValueUse`), and a string that is
 * exactly `omp`, except for the few listed in `LABELS`: the names a person sees
 * on a window, a notification or a system dialog.
 *
 * Tests are rewritten with the sources they check, so an expectation changes
 * together with the message it expects.
 *
 * The result is committed as its own generated commit. After taking a newer
 * upstream release, drop that commit and run this again instead of resolving
 * its conflicts by hand.
 *
 *   bun scripts/scient/rename-wording.ts          rewrite the tree
 *   bun scripts/scient/rename-wording.ts --check  fail when the tree is not rewritten
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "@babel/parser";
import { $ } from "bun";
import { textSpans } from "./lib/text-spans";

const PRODUCT = "Scient Agent";
const COMMAND = "scient-agent";

const repoRoot = path.resolve(import.meta.dir, "..", "..");

/** Sources and tests: only their text is rewritten. `.txt` copies are files the executable embeds. */
const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|kdl)$|\.(?:js|json)\.txt$/;
/** Prompts and built-in documentation: the whole file is text. */
const PROSE = /\.(?:md|html)$|\.html\.txt$/;

/**
 * Places where `omp` is not the agent's own words: tests that hand a generator
 * the command name `omp`, a schema library whose tests happen to use the word,
 * and benchmark tooling, where `omp` is the name of an agent to run.
 */
const SAMPLE_DATA = [
	"packages/coding-agent/test/cli/completions.test.ts",
	"packages/utils/test/cli-help.test.ts",
	"packages/omptype/",
	"packages/metaharness/",
	"packages/typescript-edit-benchmark/",
];

/** The browser extension's sources; the executable embeds a built copy of them. */
const EXTENSION = "packages/browser-relay/extension/";

/** What a path must be under, and what it must not be, to be rewritten. */
function inScope(file: string): boolean {
	if (SAMPLE_DATA.some(sample => (sample.endsWith("/") ? file.startsWith(sample) : file === sample))) return false;
	if (path.basename(file).startsWith("CHANGELOG")) return false;
	// Recorded data (model output, captured sessions) is not the agent's wording.
	if (file.includes("/test/fixtures/")) return false;
	if (/(?:^|\/)(?:README|DEVELOPMENT|LICENSE|NOTICE)[^/]*$/.test(file)) return false;
	if (/(?:^|\/)package\.json$|(?:^|\/)tsconfig[^/]*\.json$/.test(file)) return false;
	if (file.startsWith("docs/")) return PROSE.test(file);
	if (!file.startsWith("packages/")) return false;
	if (file.startsWith(EXTENSION)) return CODE.test(file) || PROSE.test(file);
	// What ships or is tested with it. Build scripts and benchmarks are tooling.
	if (!/^packages\/[^/]+\/(?:src|test|native|examples)\//.test(file)) return false;
	return CODE.test(file) || PROSE.test(file);
}

/** The agent's subcommands: `omp <one of these>` is the command, not the name. */
const SUBCOMMANDS = new Set(
	fs
		.readdirSync(path.join(repoRoot, "packages", "coding-agent", "src", "commands"))
		.filter(entry => entry.endsWith(".ts"))
		.map(entry => entry.slice(0, -3)),
);

/**
 * `omp` as a word of its own. Not part of a path, a URL scheme, a package, a
 * dotted or hyphenated name, an environment variable, or an identifier. In a
 * regular expression the separator after it can be escaped (`omp\/task`).
 */
const LOWERCASE = /(?<![A-Za-z0-9_./@:$=-])omp(?![A-Za-z0-9_/:-]|\.[A-Za-z0-9]|\\[/.:-])/g;
/**
 * `OMP` as a word of its own: not `OMP_X`, not a protocol name such as
 * `OMP.claimTarget`, and not a header such as `OMP-Auth-Broker-Capabilities`.
 */
const UPPERCASE = /\bOMP\b(?!_)(?!\.[A-Za-z])(?!-[A-Za-z]+-)/g;

/**
 * Words after which `omp` is the product in a sentence even when a subcommand's
 * name follows: "before omp read them", "another omp stream process".
 */
const NAME_AFTER = /\b(?:a|an|another|the|this|that|each|every|any|its|their|your|before|after|when|while|if)\s+$/i;

/**
 * Whether `omp` at this place is a value that keeps its spelling: the `omp` key
 * of a plugin's `package.json`, a quoted default, a header's value.
 */
function isValueUse(text: string, start: number, end: number): boolean {
	const before = text.slice(0, start);
	const after = text.slice(end);
	const opener = before.at(-1);
	const closer = after[0];
	if (opener === '"' && closer === '"') return true;
	// 'omp' after code or a keyword (`DEFAULT 'omp'`, `$which('omp')`), not after a word of a sentence.
	if (opener === "'" && closer === "'") return !/[a-z,] '$/.test(before);
	if (opener === "`" && closer === "`") {
		// The manifest key: "`omp`/`pi`", "an `omp` field", "package.json `omp`".
		if (/^`(?:\/`pi|\s+(?:field|key|manifest|object|takes precedence over `pi`))/.test(after)) return true;
		if (/package\.json\s+`$/.test(before)) return true;
	}
	// A header's value: `X-OpenRouter-Title: omp`.
	return /\b[A-Z][A-Za-z]*(?:-[A-Za-z]+)+: $/.test(before);
}

/**
 * A line one of the agent's processes prints for another to match: "omp lsp mux
 * listening on ...". The pattern that matches it is saved with the process's
 * record, so a later build must still print what an earlier build waits for.
 */
const BANNER = /^omp (?:(?!is )[a-z-]+ ){1,3}(?:listening on|serving) /;

/** Whether `omp` at this place is the command rather than the product's name. */
function isCommandUse(text: string, start: number, end: number): boolean {
	const before = text.slice(0, start);
	const after = text.slice(end);
	// Inside a code span of the text: `omp ...`. In a template string the
	// backticks are escaped, which changes nothing here.
	const ticks = before.match(/`/g)?.length ?? 0;
	if (ticks % 2 === 1) return true;
	// A flag, a slash command, or an argument placeholder follows.
	if (/^\s+(?:--?[A-Za-z]|\/[a-z]|[[<])/.test(after)) return true;
	const next = /^\s+([a-z][a-z-]*)/.exec(after)?.[1];
	return next !== undefined && SUBCOMMANDS.has(next) && !NAME_AFTER.test(before);
}

/**
 * Rewrites one run of text. `allowLowercase` is off for a string that is a
 * value; `asCommand` is on where the text is a process name, which reads like
 * the command line that started it.
 */
function rewrite(text: string, allowLowercase: boolean, asCommand = false): string {
	let next = text.replaceAll("Oh My Pi", PRODUCT);
	next = next.replace(/\b([Aa])n (OMP)\b(?!_)(?!\.[A-Za-z])(?!-[A-Za-z]+-)/g, `$1 ${PRODUCT}`);
	next = next.replace(UPPERCASE, PRODUCT);
	if (!allowLowercase) return next;
	return next.replace(LOWERCASE, (match, offset: number, whole: string) => {
		const end = offset + match.length;
		if (isValueUse(whole, offset, end)) return match;
		return asCommand || isCommandUse(whole, offset, end) ? COMMAND : PRODUCT;
	});
}

/** "an Scient Agent" after a rewrite of "an omp ...", and "the omp agent". */
function fixArticles(text: string): string {
	return text
		.replace(/\b(?:Scient Agent|scient-agent) agent\b(?!s)/g, PRODUCT)
		.replace(/\b([Aa])n ([`"'*]{0,2})(Scient Agent|scient-agent)\b/g, "$1 $2$3");
}

/** The anchor a Markdown renderer gives a heading. */
function headingAnchor(line: string): string {
	return line
		.replace(/^#{1,6}\s+/, "")
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N} _-]/gu, "")
		.replaceAll(" ", "-");
}

/** Anchors that changed because their heading was rewritten: old anchor to new. */
function renamedAnchors(before: string, after: string): Map<string, string> {
	const renamed = new Map<string, string>();
	const oldLines = before.split("\n");
	const newLines = after.split("\n");
	// The rewrite never adds or removes a line of prose.
	if (oldLines.length !== newLines.length) return renamed;
	for (let index = 0; index < oldLines.length; index += 1) {
		if (!/^#{1,6}\s/.test(oldLines[index]) || oldLines[index] === newLines[index]) continue;
		const from = headingAnchor(oldLines[index]);
		const to = headingAnchor(newLines[index]);
		if (from !== to) renamed.set(from, to);
	}
	return renamed;
}

/** Points the links of one Markdown file at the anchors that were renamed, in it or in the file a link names. */
function followAnchors(file: string, text: string, anchors: ReadonlyMap<string, ReadonlyMap<string, string>>): string {
	return text.replace(/\]\(([^)#\s]*)#([^)\s]+)\)/g, (link, target: string, anchor: string) => {
		const targetFile = target === "" ? file : path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
		const renamed = anchors.get(targetFile)?.get(anchor);
		return renamed === undefined ? link : `](${target}#${renamed})`;
	});
}

/**
 * Sentences that stay as upstream wrote them because they are about something
 * that runs a stock `omp`: RoboOMP, upstream's issue bot, whose image carries
 * its own `omp`.
 */
const KEPT: Record<string, string[]> = {
	"docs/user-facing-packages.md": ["resumes an `omp --mode rpc` session per issue"],
};

/** Rewrites a whole file of prose, around the sentences `KEPT` lists for it. */
function rewriteProse(file: string, source: string, missing: string[]): string {
	const kept = KEPT[file] ?? [];
	let text = source;
	kept.forEach((sentence, index) => {
		if (!text.includes(sentence)) missing.push(`${file}: ${sentence}`);
		text = text.replaceAll(sentence, `\u0000${index}\u0000`);
	});
	text = fixArticles(rewrite(text, true));
	kept.forEach((sentence, index) => {
		text = text.replaceAll(`\u0000${index}\u0000`, sentence);
	});
	return text;
}

interface Edit {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

/**
 * Text written between JSX tags: `<span>omp</span>`. It is neither a string nor
 * a comment, so the lexer does not report it; a parser finds the text nodes.
 * A file the parser cannot read gets no JSX edits.
 */
function jsxTextEdits(source: string): Edit[] {
	let program: unknown;
	try {
		program = parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] }).program;
	} catch {
		return [];
	}
	const edits: Edit[] = [];
	const visit = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const child of node) visit(child);
			return;
		}
		if (typeof node !== "object" || node === null) return;
		const { type, start, end } = node as { type?: unknown; start?: unknown; end?: unknown };
		if (type === "JSXText" && typeof start === "number" && typeof end === "number") {
			const text = source.slice(start, end);
			if (!/omp|OMP|Oh My Pi/.test(text)) return;
			const rewritten = fixArticles(rewrite(text, true));
			if (rewritten !== text) edits.push({ start, end, text: rewritten });
			return;
		}
		for (const key in node) {
			if (key !== "loc" && key !== "leadingComments" && key !== "trailingComments" && key !== "innerComments") {
				visit((node as Record<string, unknown>)[key]);
			}
		}
	};
	visit(program);
	return edits;
}

function rewriteCode(source: string, jsx: boolean): string {
	const spans = textSpans(source);
	const jsxEdits = jsx ? jsxTextEdits(source) : [];
	const edits: Edit[] = [...jsxEdits];
	for (const span of spans) {
		if (span.kind === "comment") continue;
		// An apostrophe in JSX text looks like a string to the lexer. The text node wins.
		if (jsxEdits.some(edit => edit.start < span.end && span.start < edit.end)) continue;
		const text = source.slice(span.start, span.end);
		if (!/omp|OMP|Oh My Pi/.test(text) || BANNER.test(text)) continue;
		const names = /\bsetProcessName\(\s*.$/.test(source.slice(Math.max(0, span.start - 32), span.start));
		// A string with no space in it is a value (an id, a key, a name on the wire).
		const rewritten = fixArticles(rewrite(text, /\s/.test(text), names));
		if (rewritten !== text) edits.push({ start: span.start, end: span.end, text: rewritten });
	}
	edits.sort((left, right) => left.start - right.start);
	let result = "";
	let cursor = 0;
	for (const edit of edits) {
		result += source.slice(cursor, edit.start) + edit.text;
		cursor = edit.end;
	}
	return result + source.slice(cursor);
}

/**
 * Names a person sees that the rules above cannot reach: a string that is only
 * `omp` (a window title, a notification's sender), and messages in the native
 * code. Each is an exact replacement on lines that are not comments. A listed
 * text that is no longer there means upstream moved it: look again, then fix
 * the list.
 *
 * Not listed, on purpose: what the agent calls itself to another program or
 * service (`originator`, `User-Agent`, the terminal handshake, Warp's agent
 * name), ids of built-in images and icons, and names of stored things.
 */
const LABELS: Record<string, [from: string, to: string][]> = {
	"packages/coding-agent/src/tools/ask.ts": [['title: "omp"', `title: "${PRODUCT}"`]],
	"packages/coding-agent/src/modes/controllers/event-controller.ts": [
		['sessionName || "omp"', `sessionName || "${PRODUCT}"`],
	],
	"packages/coding-agent/src/debug/index.ts": [['sessionName || "omp"', `sessionName || "${PRODUCT}"`]],
	"packages/coding-agent/src/utils/title-generator.ts": [
		['NATIVE_TERMINAL_TITLE = "omp"', `NATIVE_TERMINAL_TITLE = "${PRODUCT}"`],
	],
	"packages/coding-agent/test/title-generator.test.ts": [
		['emittedTitles().at(-1)).toBe("omp")', `emittedTitles().at(-1)).toBe("${PRODUCT}")`],
	],
	"packages/coding-agent/src/modes/acp/acp-agent.ts": [
		['name: "omp"', `name: "${COMMAND}"`],
		['title: "omp"', `title: "${PRODUCT}"`],
	],
	"packages/coding-agent/test/acp-initialize-conformance.test.ts": [['title: "omp"', `title: "${PRODUCT}"`]],
	"packages/coding-agent/src/dap/session.ts": [
		['clientID: "omp"', `clientID: "${COMMAND}"`],
		['clientName: "omp"', `clientName: "${PRODUCT}"`],
	],
	"packages/tui/src/overlays/composer-shape-preview.ts": [['PREVIEW_TITLE = "omp"', `PREVIEW_TITLE = "${PRODUCT}"`]],
	"packages/tui/src/terminal-capabilities.ts": [
		['CMUX_NOTIFICATION_TITLE = "omp"', `CMUX_NOTIFICATION_TITLE = "${PRODUCT}"`],
		['OSC99_APP_NAME = "omp"', `OSC99_APP_NAME = "${PRODUCT}"`],
	],
	"packages/tui/test/composer-shape-preview.test.ts": [['toContain("omp")', `toContain("${PRODUCT}")`]],
	"packages/tui/test/notifications.test.ts": [
		// The sender's name, base64-encoded as the terminal protocol carries it.
		["f=b21w", `f=${Buffer.from(PRODUCT).toString("base64")}`],
		['["omp", "-x session"]', `["${PRODUCT}", "-x session"]`],
	],
	"packages/tui/src/native/backend.ts": [['title: "omp"', `title: "${PRODUCT}"`]],
	"crates/pi-natives/src/power.rs": [['"omp agent session"', `"${PRODUCT} session"`]],
	"crates/pi-natives/src/desktop/win32/window.rs": [["run omp at the same", `run ${COMMAND} at the same`]],
	// "Oh My Pi is handling ..." in these two files is about the other product, and stays.
	"crates/pi-natives/src/oauth_callback/darwin.rs": [
		["omp application", `${PRODUCT} application`],
		["omp callback", `${PRODUCT} callback`],
	],
	"crates/pi-natives/src/oauth_callback/linux.rs": [["Name=omp OAuth Callback", `Name=${PRODUCT} OAuth Callback`]],
	"crates/pi-natives/src/applefm/mod.rs": [["This omp build", `This ${PRODUCT} build`]],
	"crates/pi-voice/src/device/linux.rs": [['c"omp"', `c"${COMMAND}"`]],
};

const isCommentLine = (line: string): boolean => /^\s*(?:\/\/|\/\*|\*)/.test(line);

/** Applies a file's listed labels. `missing` collects the ones found in neither form. */
function applyLabels(file: string, source: string, missing: string[]): string {
	const lines = source.split("\n");
	for (const [from, to] of LABELS[file] ?? []) {
		let seen = false;
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (isCommentLine(line)) continue;
			if (line.includes(from)) {
				lines[index] = line.replaceAll(from, to);
				seen = true;
			} else if (line.includes(to)) {
				seen = true;
			}
		}
		if (!seen) missing.push(`${file}: ${from}`);
	}
	return lines.join("\n");
}

const check = process.argv.includes("--check");
const files = (await $`git -C ${repoRoot} ls-files -z -- packages docs`.quiet().text()).split("\0").filter(inScope);

let changed = 0;
const stale: string[] = [];
const missing: string[] = [];
/** Every file's text before and after, so links can follow headings that another file renamed. */
const results = new Map<string, { source: string; next: string }>();
const anchors = new Map<string, Map<string, string>>();
for (const file of files) {
	const source = await Bun.file(path.join(repoRoot, file)).text();
	let next = source;
	if (/omp|OMP|Oh My Pi/.test(source)) {
		next = PROSE.test(file) ? rewriteProse(file, source, missing) : rewriteCode(source, /\.[jt]sx$/.test(file));
	}
	results.set(file, { source, next });
	if (file.endsWith(".md") && next !== source) anchors.set(file, renamedAnchors(source, next));
}
for (const [file, result] of results) {
	const next = file.endsWith(".md") ? followAnchors(file, result.next, anchors) : result.next;
	if (next === result.source) continue;
	if (check) {
		stale.push(file);
		continue;
	}
	await Bun.write(path.join(repoRoot, file), next);
	changed += 1;
}

const native: string[] = [];
for (const file of Object.keys(LABELS)) {
	const absolute = path.join(repoRoot, file);
	const source = await Bun.file(absolute).text();
	const next = applyLabels(file, source, missing);
	if (next === source) continue;
	if (check) {
		if (!stale.includes(file)) stale.push(file);
		continue;
	}
	await Bun.write(absolute, next);
	changed += 1;
	if (file.endsWith(".rs")) native.push(file);
}
if (missing.length > 0) {
	console.error(`Listed texts that are no longer in the source:\n  ${missing.join("\n  ")}`);
	process.exit(1);
}

if (check) {
	if (stale.length > 0) {
		console.error(
			`${stale.length} files still name the product as upstream does:\n  ${stale.slice(0, 40).join("\n  ")}`,
		);
		process.exit(1);
	}
	console.log("The agent's wording names Scient Agent.");
} else {
	// Longer and shorter strings can change how a line wraps.
	if (changed > 0) await $`bun run fmt:tools`.cwd(repoRoot).quiet().nothrow();
	// Only the files touched: the whole workspace is not this script's to format.
	if (native.length > 0) await $`rustfmt ${native}`.cwd(repoRoot).quiet().nothrow();
	console.log(`Rewrote the wording in ${changed} files.`);
}
