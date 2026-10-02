/**
 * Finds the parts of a TypeScript or JavaScript source that hold text rather
 * than code: string literals, the literal parts of template strings, regular
 * expression literals (a test often expects a message through one), and
 * comments. It is a lexer, not a parser: enough to tell text from identifiers
 * so wording can be changed without touching code. Whatever it gets wrong is
 * caught by the type check and the tests that run after every regeneration.
 */
export interface TextSpan {
	/** Offset of the first character of the text (after the opening quote). */
	readonly start: number;
	/** Offset just past the last character of the text (before the closing quote). */
	readonly end: number;
	readonly kind: "string" | "template" | "regex" | "comment";
}

/** Tokens after which a `/` starts a regular expression rather than a division. */
const REGEX_PRECEDERS = new Set([
	"(",
	",",
	"=",
	":",
	"[",
	"!",
	"&",
	"|",
	"?",
	"{",
	"}",
	";",
	"+",
	"-",
	"*",
	"%",
	"<",
	">",
	"~",
	"^",
]);
const REGEX_KEYWORDS = /(?:^|[^A-Za-z0-9_$])(?:return|typeof|case|in|of|do|else|void|throw|new|delete|await|yield)$/;

/** A stretch of the source the lexer steps over: JSX text, where a quote is just a character. */
export interface SkippedRange {
	readonly start: number;
	readonly end: number;
}

export function textSpans(source: string, skipped: readonly SkippedRange[] = []): TextSpan[] {
	const spans: TextSpan[] = [];
	const length = source.length;
	const skipTo = new Map<number, number>();
	for (const range of skipped) if (range.end > range.start) skipTo.set(range.start, range.end);
	// Each entry is the brace depth at which a `${` substitution of an open template ends.
	const templates: number[] = [];
	let depth = 0;
	let index = 0;
	// The last few characters of code, with one space wherever whitespace or a
	// comment separated two tokens. What precedes a slash decides what it is.
	let tail = "";
	const note = (text: string): void => {
		tail = (tail + text).slice(-16);
	};
	const gap = (): void => {
		if (tail !== "" && !tail.endsWith(" ")) note(" ");
	};

	const readTemplate = (from: number): number => {
		let cursor = from;
		const start = from;
		while (cursor < length) {
			const char = source[cursor];
			if (char === "\\") {
				cursor += 2;
				continue;
			}
			if (char === "`") {
				spans.push({ start, end: cursor, kind: "template" });
				note("`");
				return cursor + 1;
			}
			if (char === "$" && source[cursor + 1] === "{") {
				spans.push({ start, end: cursor, kind: "template" });
				templates.push(depth);
				depth += 1;
				note("{");
				return cursor + 2;
			}
			cursor += 1;
		}
		spans.push({ start, end: length, kind: "template" });
		return length;
	};

	while (index < length) {
		const resume = skipTo.get(index);
		if (resume !== undefined) {
			index = resume;
			gap();
			continue;
		}
		const char = source[index];
		const next = source[index + 1];
		if (char === "/" && next === "/") {
			const end = source.indexOf("\n", index);
			const stop = end === -1 ? length : end;
			spans.push({ start: index + 2, end: stop, kind: "comment" });
			index = stop;
			gap();
			continue;
		}
		if (char === "/" && next === "*") {
			const end = source.indexOf("*/", index + 2);
			const stop = end === -1 ? length : end;
			spans.push({ start: index + 2, end: stop, kind: "comment" });
			index = stop + 2;
			gap();
			continue;
		}
		if (char === '"' || char === "'") {
			let cursor = index + 1;
			while (cursor < length && source[cursor] !== char && source[cursor] !== "\n") {
				cursor += source[cursor] === "\\" ? 2 : 1;
			}
			spans.push({ start: index + 1, end: Math.min(cursor, length), kind: "string" });
			index = cursor + 1;
			note(char);
			continue;
		}
		if (char === "`") {
			index = readTemplate(index + 1);
			continue;
		}
		if (char === "/") {
			const before = tail.trimEnd();
			const lastSignificant = before.at(-1) ?? "";
			// `n++ / 2`, `n-- / 2` and `n! / 2` divide: the operator before the slash is a postfix one.
			// A `!` after a keyword (`return !/x/.test(y)`) is the prefix operator.
			const operand = /^(.*[\w$)\]])\s*!$/s.exec(before)?.[1];
			const afterPostfix = /(?:\+\+|--)$/.test(before) || (operand !== undefined && !REGEX_KEYWORDS.test(operand));
			const startsRegex =
				!afterPostfix &&
				(lastSignificant === "" || REGEX_PRECEDERS.has(lastSignificant) || REGEX_KEYWORDS.test(before));
			if (startsRegex) {
				let cursor = index + 1;
				let inClass = false;
				while (cursor < length && source[cursor] !== "\n") {
					const current = source[cursor];
					if (current === "\\") {
						cursor += 2;
						continue;
					}
					if (current === "[") inClass = true;
					else if (current === "]") inClass = false;
					else if (current === "/" && !inClass) break;
					cursor += 1;
				}
				// A regular expression closes on its own line, and no operand follows it:
				// `a / b / 2` is two divisions. A slash that fails either test is a division.
				const follows = /^[A-Za-z]*[ \t]*([\w$"'`([{]?)/.exec(source.slice(cursor + 1, cursor + 48))?.[1];
				if (source[cursor] === "/" && follows === "") {
					spans.push({ start: index + 1, end: cursor, kind: "regex" });
					index = cursor + 1;
					note("/");
					continue;
				}
			}
		}
		if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (templates.length > 0 && templates[templates.length - 1] === depth) {
				templates.pop();
				index = readTemplate(index + 1);
				continue;
			}
		}
		if (/\s/.test(char)) gap();
		else note(char);
		index += 1;
	}
	return spans;
}
