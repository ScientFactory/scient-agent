/**
 * Scient's marker blocks: the comments that wrap every hand-written change
 * inside a file Oh My Pi owns.
 *
 *   // scient(SA-AUTH): begin - why the change exists
 *   ...the changed lines...
 *   // scient(SA-AUTH): end
 *
 * The comment opener follows the file's language: `//` for TypeScript,
 * JavaScript, Rust, Go and KDL; `#` for Python, YAML, TOML, shell and Bazel;
 * `<!-- ... -->` for Markdown, HTML, SVG and XML; `/* ... *\/` for CSS. TSX and
 * JSX also accept `{/* ... *\/}` inside markup. JSON cannot hold comments, so
 * its changes are registered by JSON pointer in the ledger instead.
 */
import * as path from "node:path";
import { type ParserPlugin, parse } from "@babel/parser";

export interface MarkerBlock {
	id: string;
	/** 1-based line of the `begin` comment. */
	begin: number;
	/** 1-based line of the `end` comment. */
	end: number;
}

export interface MarkerScan {
	blocks: MarkerBlock[];
	errors: string[];
}

type Syntax = "slash" | "hash" | "html" | "css" | "jsx";

const BY_EXTENSION: Record<string, Syntax[]> = {
	".ts": ["slash"],
	".mts": ["slash"],
	".cts": ["slash"],
	".js": ["slash"],
	".mjs": ["slash"],
	".cjs": ["slash"],
	".tsx": ["slash", "jsx"],
	".jsx": ["slash", "jsx"],
	".rs": ["slash"],
	".go": ["slash"],
	".kdl": ["slash"],
	".c": ["slash"],
	".h": ["slash"],
	".m": ["slash"],
	".swift": ["slash"],
	".py": ["hash"],
	".yml": ["hash"],
	".yaml": ["hash"],
	".toml": ["hash"],
	".sh": ["hash"],
	".bash": ["hash"],
	".bzl": ["hash"],
	".bazel": ["hash"],
	".md": ["html"],
	// A <style> block takes CSS comments.
	".html": ["html", "css"],
	".svg": ["html", "css"],
	".xml": ["html"],
	".plist": ["html"],
	".css": ["css"],
};

const BY_NAME: Record<string, Syntax[]> = {
	Dockerfile: ["hash"],
	"BUILD.bazel": ["hash"],
	".gitignore": ["hash"],
	".gitattributes": ["hash"],
};

/**
 * The comment syntaxes a file accepts, or undefined when it cannot hold a
 * marker. Text assets keep their inner language: `background.js.txt` is
 * JavaScript.
 */
export function markerSyntaxes(file: string): Syntax[] | undefined {
	const base = path.posix.basename(file);
	if (BY_NAME[base]) return BY_NAME[base];
	const inner = base.endsWith(".txt") ? base.slice(0, -".txt".length) : base;
	return BY_EXTENSION[path.posix.extname(inner)];
}

const ID = "([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)";
const BODY = `scient\\(${ID}\\): (?:begin - (\\S.*?)|end)`;
const PATTERNS: Record<Syntax, RegExp> = {
	slash: new RegExp(`^\\s*//\\s*${BODY}\\s*$`),
	hash: new RegExp(`^\\s*#\\s*${BODY}\\s*$`),
	html: new RegExp(`^\\s*<!--\\s*${BODY}\\s*-->\\s*$`),
	css: new RegExp(`^\\s*/\\*\\s*${BODY}\\s*\\*/\\s*$`),
	jsx: new RegExp(`^\\s*\\{/\\*\\s*${BODY}\\s*\\*/\\}\\s*$`),
};
/** Any line that mentions a marker, used to catch ones written in the wrong form. */
const LOOSE = /scient\([A-Za-z0-9-]*\)\s*:\s*(begin|end)\b/;

/** Finds the marker blocks in one file's text. */
export function scanMarkers(file: string, text: string): MarkerScan {
	const blocks: MarkerBlock[] = [];
	const errors: string[] = [];
	const syntaxes = markerSyntaxes(file);
	let open: { id: string; line: number } | undefined;
	const lines = text.split(/\r?\n/);
	let isComment: ((line: number, column: number) => boolean) | undefined;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const number = index + 1;
		if (!LOOSE.test(line)) continue;
		const match = syntaxes?.map(syntax => PATTERNS[syntax].exec(line)).find(Boolean);
		if (!match) {
			errors.push(
				`${file}:${number}: marker is not a whole ${syntaxes ? "comment line" : "line in a file that can hold one"}`,
			);
			continue;
		}
		isComment ??= commentCheck(file, text, errors);
		if (!isComment(number, line.search(/\S/))) {
			errors.push(`${file}:${number}: marker sits inside a string, comment or code block, so it is not a comment`);
			continue;
		}
		const [, id, reason] = match;
		const isBegin = reason !== undefined;
		if (isBegin) {
			if (open) errors.push(`${file}:${number}: ${id} begins inside ${open.id}, which began on line ${open.line}`);
			else open = { id, line: number };
		} else if (!open) {
			errors.push(`${file}:${number}: ${id} ends without a begin`);
		} else if (open.id !== id) {
			errors.push(`${file}:${number}: ${id} ends ${open.id}, which began on line ${open.line}`);
			open = undefined;
		} else {
			blocks.push({ id, begin: open.line, end: number });
			open = undefined;
		}
	}
	if (open) errors.push(`${file}:${open.line}: ${open.id} never ends`);
	return { blocks, errors };
}

/** The block that contains a 1-based line, if any. */
export function blockAt(blocks: readonly MarkerBlock[], line: number): MarkerBlock | undefined {
	return blocks.find(block => block.begin <= line && line <= block.end);
}

/** Standard decorators and `accessor` fields, which TypeScript and Bun accept. */
const DECORATORS: ParserPlugin[] = [["decorators", {}], "decoratorAutoAccessors"];
/** Babel's plugins for each JavaScript and TypeScript extension. */
const BABEL_PLUGINS: Record<string, ParserPlugin[]> = {
	".ts": ["typescript", ...DECORATORS],
	".mts": ["typescript", ...DECORATORS],
	".cts": ["typescript", ...DECORATORS],
	".tsx": ["typescript", "jsx", ...DECORATORS],
	".js": DECORATORS,
	".mjs": DECORATORS,
	".cjs": DECORATORS,
	".jsx": ["jsx", ...DECORATORS],
};

/**
 * Where Babel's comments start, read as the extension says the code runs: a
 * `.cjs` file as CommonJS, `.mjs` and `.mts` as modules, and the rest either
 * way. A module and a script can tokenize the same text differently (`await`
 * is a keyword only in a module), so each reading that parses must agree.
 * Babel's error recovery is not used: it can misplace comments.
 */
function commentStarts(text: string, extension: string, plugins: ParserPlugin[]): Set<number | undefined> {
	const sourceTypes: Array<"module" | "commonjs"> =
		extension === ".cjs"
			? ["commonjs"]
			: extension === ".mjs" || extension === ".mts"
				? ["module"]
				: ["module", "commonjs"];
	const readings: Array<Array<number | undefined>> = [];
	let failure: unknown;
	for (const sourceType of sourceTypes) {
		try {
			readings.push((parse(text, { sourceType, plugins }).comments ?? []).map(comment => comment.start));
		} catch (error) {
			failure ??= error;
		}
	}
	if (readings.length === 0) throw failure;
	if (readings.some(reading => reading.join() !== readings[0].join())) {
		throw new Error("it parses both as a module and as a script, and they place its comments differently");
	}
	return new Set(readings[0]);
}

/**
 * Whether the marker that starts at a place (1-based line, 0-based column) is
 * a comment of its own, as the file's language reads it, rather than text in
 * a string, template, comment or code block. JavaScript and TypeScript, JSX
 * included, are read by Babel, as the wording generator reads them; Markdown
 * by Bun's CommonMark parser; Rust by a small lexer. Other languages are not
 * checked. A file that cannot be read is reported, and its markers pass.
 */
function commentCheck(file: string, text: string, errors: string[]): (line: number, column: number) => boolean {
	const base = path.posix.basename(file).replace(/\.txt$/, "");
	const extension = path.posix.extname(base);
	const starts = [0];
	for (let index = 0; index < text.length; index++) if (text[index] === "\n") starts.push(index + 1);
	const offsetOf = (line: number, column: number) => starts[line - 1] + column;
	try {
		const plugins = BABEL_PLUGINS[extension];
		if (plugins) {
			// A declaration file holds ambient declarations, such as a `const` without a value.
			const declarations = /\.d\.[cm]?ts$/.test(base);
			const opened = commentStarts(
				text,
				extension,
				plugins.map(plugin => (declarations && plugin === "typescript" ? ["typescript", { dts: true }] : plugin)),
			);
			return (line, column) => {
				const offset = offsetOf(line, column);
				// `{/* ... */}` in markup opens its comment one character in.
				return opened.has(text[offset] === "{" ? offset + 1 : offset);
			};
		}
		if (extension === ".rs") {
			const literals = rustLiterals(text);
			return (line, column) => {
				const offset = offsetOf(line, column);
				return !literals.some(([start, end]) => start <= offset && offset < end);
			};
		}
		if (extension === ".md") {
			const code = markdownTextLines(text);
			return line => !code.has(line);
		}
	} catch (error) {
		errors.push(`${file}: cannot be parsed, so its markers cannot be checked: ${String(error)}`);
	}
	return () => true;
}

/** Rust string literals (plain, byte and raw) and block comments, as offset ranges. */
function rustLiterals(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	let index = 0;
	while (index < text.length) {
		const rest = text.slice(index, index + 2);
		if (rest === "//") {
			while (index < text.length && text[index] !== "\n") index++;
			continue;
		}
		if (rest === "/*") {
			// Rust block comments nest.
			const start = index + 2;
			let depth = 1;
			index += 2;
			while (index < text.length && depth > 0) {
				const pair = text.slice(index, index + 2);
				if (pair === "/*" || pair === "*/") {
					depth += pair === "/*" ? 1 : -1;
					index += 2;
				} else {
					index++;
				}
			}
			ranges.push([start, index]);
			continue;
		}
		const raw = /^b?r(#*)"/.exec(text.slice(index, index + 40));
		if (raw && (index === 0 || !/[A-Za-z0-9_]/.test(text[index - 1]))) {
			const close = `"${raw[1]}`;
			const start = index + raw[0].length;
			const end = text.indexOf(close, start);
			ranges.push([start, end < 0 ? text.length : end]);
			index = end < 0 ? text.length : end + close.length;
			continue;
		}
		if (text[index] === "'") {
			// A character literal; a lifetime has no closing quote.
			const char = /^'(?:\\.|[^\\'\n])'/.exec(text.slice(index, index + 12));
			index += char ? char[0].length : 1;
			continue;
		}
		if (text[index] === '"') {
			const start = index + 1;
			index = start;
			while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
			ranges.push([start, index]);
			index++;
			continue;
		}
		index++;
	}
	return ranges;
}

/**
 * Lines of a Markdown text holding a marker that is not an HTML comment of its
 * own. The text is rendered to HTML, which keeps raw HTML verbatim and escapes
 * code and text, and the HTML is read by Bun's HTML tokenizer, so a `<!--` in
 * an attribute or in `<textarea>`, `<script>` or other raw text is not a
 * comment. Every mention of a marker in the text appears once in the rendered
 * HTML, in order; a line is a comment when its mention is a comment node whose
 * text is the line's own comment text.
 */
function markdownTextLines(text: string): Set<number> {
	const mention = new RegExp(LOOSE.source, "g");
	const source = text.split(/\r?\n/);
	const lines: number[] = [];
	source.forEach((line, index) => {
		for (const _ of line.matchAll(mention)) lines.push(index + 1);
	});
	const html = Bun.markdown.html(text);
	// Each comment that mentions a marker becomes tokens, which the text cannot forge: it is chosen after rendering.
	let token: string;
	do token = `@${crypto.randomUUID()}@`;
	while (html.includes(token));
	const comments: string[] = [];
	const marked = new HTMLRewriter()
		.onDocument({
			comments(comment) {
				const found = comment.text.match(mention);
				if (!found) return;
				comment.replace(found.map(() => `${token}${comments.length}${token}`).join(""));
				comments.push(comment.text);
			},
		})
		.transform(html);
	const rendered = [...marked.matchAll(new RegExp(`${token}(\\d+)${token}|${LOOSE.source}`, "g"))].map(found =>
		found[1] === undefined ? undefined : comments[Number(found[1])],
	);
	if (rendered.length !== lines.length) throw new Error("its markers do not all appear in the rendered text");
	return new Set(
		lines.filter((line, index) => {
			const comment = rendered[index];
			return comment === undefined || comment !== /^\s*<!--(.*)-->\s*$/.exec(source[line - 1])?.[1];
		}),
	);
}
