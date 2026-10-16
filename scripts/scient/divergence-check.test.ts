import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { changedPointers, checkDivergence } from "./divergence-check";
import { formatTools } from "./lib/format";
import { matchesPath, parseLedger } from "./lib/ledger";
import { scanMarkers } from "./lib/markers";

// Every case drives git through many short processes, which is slow on Windows.
setDefaultTimeout(60_000);

const repos: string[] = [];
afterEach(() => {
	for (const repo of repos.splice(0)) fs.rmSync(repo, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.toString().trim();
}

function write(repo: string, files: Record<string, string | Uint8Array | null>): void {
	for (const [file, content] of Object.entries(files)) {
		const target = path.join(repo, file);
		if (content === null) fs.rmSync(target);
		else {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content);
		}
	}
}

function commit(repo: string, message: string, files: Record<string, string | Uint8Array | null>): string {
	write(repo, files);
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "--allow-empty", "-m", message);
	return git(repo, "rev-parse", "HEAD");
}

const WIRE = "packages/coding-agent/src/modes/rpc/wire/rpc-wire.generated.ts";
const A =
	"export const name = 'omp';\nexport function one() {\n\treturn 1;\n}\nexport function two() {\n\treturn 2;\n}\n";
const CONFIG = JSON.stringify({ name: "omp", nested: { port: 9224, keep: true } }, null, "\t");
const UPSTREAM: Record<string, string | Uint8Array> = {
	"src/a.ts": A,
	"src/prompt.md": "You are omp.\n",
	"src/logo.bin": new Uint8Array([0, 1, 2, 3, 0, 255]),
	"config.json": CONFIG,
	".github/workflows/ci.yml": "name: CI\n",
	[WIRE]: "export type Wire = 1;\n",
	// A deterministic stand-in for the identity generator.
	"scripts/scient/rename-identity.ts":
		"const f = 'src/a.ts'; await Bun.write(f, (await Bun.file(f).text()).replace(\"'omp'\", \"'scient'\"));\n",
};
const MARKED_ONE = A.replace(
	"\treturn 1;",
	"\t// scient(SA-AUTH): begin - why\n\treturn 10;\n\t// scient(SA-AUTH): end",
);

function ledger(entries: Record<string, unknown>): string {
	return JSON.stringify({ schemaVersion: 1, entries }, null, "\t");
}

const BASE_ENTRIES = {
	"SA-RELEASE": {
		status: "active",
		contract: "Scient's own files.",
		owned: ["scient.json", "scripts/scient/**", "package.json", "bun.lock", "dep/**", ".gitignore"],
	},
};
const AUTH = { ...BASE_ENTRIES, "SA-AUTH": { status: "active", contract: "Sign-ins.", upstream: ["src/a.ts"] } };

/** An upstream commit and an accepted replay on it, tagged with its checkpoint (the same commit here). */
function setup(entries: Record<string, unknown> = BASE_ENTRIES, extra: Record<string, string> = {}) {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "divergence-check-"));
	repos.push(repo);
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "test");
	git(repo, "config", "core.autocrlf", "false");
	const upstream = commit(repo, "upstream", UPSTREAM);
	const scient = JSON.stringify({
		name: "scient-agent",
		version: "0.1.0",
		upstream: { name: "oh-my-pi", version: "1.0.0", commit: upstream },
	});
	const replay = commit(repo, "scient: add the ledger\n\nScient-Divergence: SA-RELEASE", {
		"scient.json": scient,
		"scripts/scient/divergences.json": ledger(entries),
		...extra,
	});
	git(repo, "tag", "-a", "omp-sync/v1.0.0", "-m", `Oh My Pi 1.0.0\n\nScient-Checkpoint: ${replay}`, replay);
	return { repo, upstream, replay };
}

async function check(repo: string, options: { replay?: string; regenerate?: boolean } = {}) {
	return checkDivergence({ repo, regenerate: options.regenerate ?? false, checkRpc: false, ...options });
}

const problemsOf = async (repo: string, options?: { replay?: string; regenerate?: boolean }) =>
	(await check(repo, options)).problems.join("\n");

describe("markers", () => {
	it("finds well-formed blocks in each language", () => {
		const ts = scanMarkers("a.ts", "x\n// scient(SA-AUTH): begin - why\ny\n// scient(SA-AUTH): end\n");
		expect(ts).toEqual({ blocks: [{ id: "SA-AUTH", begin: 2, end: 4 }], errors: [] });
		const md = scanMarkers("a.md", "<!-- scient(SA-POLICY): begin - why -->\nz\n<!-- scient(SA-POLICY): end -->\n");
		expect(md.blocks).toHaveLength(1);
		const tsx = scanMarkers("a.tsx", "{/* scient(SA-BRAND): begin - why */}\n<b/>\n{/* scient(SA-BRAND): end */}\n");
		expect(tsx.blocks).toHaveLength(1);
		const asset = scanMarkers("background.js.txt", "// scient(SA-RELAY): begin - why\n// scient(SA-RELAY): end\n");
		expect(asset.blocks).toHaveLength(1);
	});

	it("rejects a marker inside a string, template, raw string, block comment or code fence", () => {
		const marker = "// scient(SA-X): begin - why\n// scient(SA-X): end\n";
		const inside = "inside a string, comment or code block";
		expect(scanMarkers("a.ts", `const s = \`\n${marker}\`;\n`).errors[0]).toContain(inside);
		expect(scanMarkers("a.ts", `/**\n ${marker} */\nexport {};\n`).errors[0]).toContain(inside);
		expect(scanMarkers("a.rs", `const S: &str = r#"\n${marker}"#;\n`).errors[0]).toContain(inside);
		expect(scanMarkers("a.rs", `/* /* nested */\n${marker}*/\n`).errors[0]).toContain(inside);
		const fenced = "```ts\n<!-- scient(SA-X): begin - why -->\n<!-- scient(SA-X): end -->\n```\n";
		expect(scanMarkers("a.md", fenced).errors[0]).toContain(inside);
		// The same markers as comments of their own.
		expect(scanMarkers("a.ts", `const s = "x";\n${marker}`).errors).toEqual([]);
		expect(scanMarkers("a.rs", `let c = '"';\nlet s = "a";\n${marker}fn f<'a>() {}\n`).errors).toEqual([]);
	});

	it("reads code and Markdown as their parsers do", () => {
		const marker = "// scient(SA-X): begin - why\n// scient(SA-X): end\n";
		const inside = "inside a string, comment or code block";
		// A regex after a condition: a brace in it does not keep the template open, and `/*` in it opens no comment.
		const template = `const s = \`\${(() => { if (ok) /{/.test(s); return 1; })()}\n${marker}\`;\n`;
		expect(scanMarkers("a.ts", template).errors[0]).toContain(inside);
		expect(scanMarkers("a.ts", `if (ok) /[/*]/.test(s);\n${marker}`).errors).toEqual([]);
		// Text in markup is not a comment; a `{/* */}` child is.
		expect(scanMarkers("a.tsx", `const a = <p>\n${marker}</p>;\n`).errors[0]).toContain(inside);
		const child = "{/* scient(SA-X): begin - why */}\n{/* scient(SA-X): end */}\n";
		expect(scanMarkers("a.tsx", `const a = <p>\n${child}</p>;\n`).errors).toEqual([]);
		expect(scanMarkers("a.ts", `const = ;\n${marker}`).errors[0]).toContain("cannot be parsed");

		const md = "<!-- scient(SA-X): begin - why -->\n<!-- scient(SA-X): end -->\n";
		// Backticks in an indented code block open no fence.
		expect(scanMarkers("a.md", `Text.\n\n    \`\`\`\n    code\n\n${md}`).errors).toEqual([]);
		// A fence opens on a list item's line.
		const listed = md.replace(/^/gm, "  ").trimEnd();
		expect(scanMarkers("a.md", `- \`\`\`html\n${listed}\n  \`\`\`\n`).errors[0]).toContain(inside);
		// A closing fence takes no text after it.
		expect(scanMarkers("a.md", `\`\`\`\ncode\n\`\`\` not-a-close\n${md}\`\`\`\n`).errors[0]).toContain(inside);
	});

	it("reads CommonJS as a script, where `await` is a name and `/*` opens a comment", () => {
		const marker = "// scient(SA-X): begin - why\n// scient(SA-X): end\n";
		const text = `var await = 1, g = 1;\nconst x = await / [/*] /g;\n${marker}0 */] /g;\n`;
		expect(scanMarkers("a.cjs", text).errors[0]).toContain("inside a string, comment or code block");
	});

	it("parses decorators and auto-accessors", () => {
		const marker = "// scient(SA-X): begin - why\n// scient(SA-X): end\n";
		const text = `@sealed class C {\n\t@logged accessor x = 1;\n}\n${marker}`;
		expect(scanMarkers("a.ts", text)).toEqual({ blocks: [{ id: "SA-X", begin: 4, end: 5 }], errors: [] });
	});

	it("rejects a Markdown marker inside raw HTML that keeps it as text", () => {
		const md = "<!-- scient(SA-X): begin - why -->\n<!-- scient(SA-X): end -->\n";
		const inside = "inside a string, comment or code block";
		expect(scanMarkers("a.md", `<textarea>\n${md}</textarea>\n`).errors[0]).toContain(inside);
		expect(scanMarkers("a.md", `<div title="a\n${md}">\n`).errors[0]).toContain(inside);
	});

	it("rejects a Markdown marker after a blank line inside a quoted attribute", () => {
		const md = "<!-- scient(SA-X): begin - why -->\n<!-- scient(SA-X): end -->\n";
		// The blank line ends the HTML block, but not the attribute.
		expect(scanMarkers("a.md", `<div title="\n\n${md}">\n`).errors[0]).toContain(
			"inside a string, comment or code block",
		);
	});

	it("does not let later raw HTML stand in for a Markdown marker in a code block", () => {
		const md = "<!-- scient(SA-X): begin - why -->\n<!-- scient(SA-X): end -->\n";
		// NUL-delimited numbers, as an earlier scheme marked each mention it read.
		const forged = "<!-- \u00000\u0000 - why -->\n<!-- \u00001\u0000 -->\n";
		expect(scanMarkers("a.md", `\`\`\`\n${md}\`\`\`\n\n${forged}`).errors[0]).toContain(
			"inside a string, comment or code block",
		);
	});

	it("rejects markers in the wrong form, nested, unclosed or mismatched", () => {
		expect(scanMarkers("a.ts", "# scient(SA-X): begin - why\n").errors[0]).toContain("not a whole comment line");
		expect(scanMarkers("a.ts", "const s = 'scient(SA-X): begin - why';\n").errors[0]).toContain(
			"not a whole comment line",
		);
		const nested = "// scient(SA-A): begin - a\n// scient(SA-B): begin - b\n// scient(SA-A): end\n";
		expect(scanMarkers("a.ts", nested).errors.join("\n")).toContain("begins inside SA-A");
		expect(scanMarkers("a.ts", "// scient(SA-A): begin - a\n").errors[0]).toContain("never ends");
		expect(scanMarkers("a.ts", "// scient(SA-A): end\n").errors[0]).toContain("without a begin");
	});
});

describe("ledger", () => {
	it("matches exact paths and globs", () => {
		expect(matchesPath("scripts/scient/**", "scripts/scient/lib/markers.ts")).toBe(true);
		expect(matchesPath("scripts/scient/*.ts", "scripts/scient/lib/markers.ts")).toBe(false);
		expect(matchesPath("packages/**/scient-*.test.ts", "packages/ai/test/scient-callback-page.test.ts")).toBe(true);
	});

	it("rejects unknown keys, bad ids, unnormalized paths, bad pointers and undocumented retirements", () => {
		const one = (entry: Record<string, unknown>) => () =>
			parseLedger(ledger({ "SA-X": { contract: "c", ...entry } }));
		expect(() => parseLedger(ledger({ "sa-x": { status: "active", contract: "c" } }))).toThrow("upper-case");
		expect(one({ status: "active", files: [] })).toThrow('unknown key "files"');
		expect(one({ status: "retired", disposition: " " })).toThrow("disposition");
		expect(one({ status: "active", owned: ["./a.ts"] })).toThrow("normalized");
		expect(one({ status: "active", owned: ["a\\b.ts"] })).toThrow("normalized");
		expect(one({ status: "active", json: { "a.json": ["port"] } })).toThrow("JSON pointer");
	});

	it("lists changed JSON pointers", () => {
		expect(changedPointers({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 }, d: 4 })).toEqual(["/b/c", "/d"]);
		expect(changedPointers({ "x/y": 1 }, { "x/y": 2 })).toEqual(["/x~1y"]);
	});
});

describe("after an accepted alignment", () => {
	it("accepts a marked change in a listed file, and reports the footprint it leaves", async () => {
		const { repo } = setup(AUTH);
		commit(repo, "scient: mark", { "src/a.ts": MARKED_ONE });
		const result = await check(repo);
		expect(result.problems).toEqual([]);
		expect(result.commits).toBe(1);
		const one = { files: 1, blocks: 1, lines: 1 };
		expect(result.footprint).toEqual({ ...one, byEntry: { "SA-AUTH": one } });
	});

	it("rejects a change outside a block", async () => {
		const { repo } = setup(AUTH);
		commit(repo, "scient: mark", { "src/a.ts": MARKED_ONE.replace("\treturn 2;", "\treturn 20;") });
		expect(await problemsOf(repo)).toContain("src/a.ts:8 changes Oh My Pi's code outside a scient(ID) block");
	});

	it("rejects a removal of Oh My Pi's lines with no block where it happened", async () => {
		const { repo } = setup(AUTH);
		commit(repo, "scient: mark", {
			// The block explains nothing near the removal.
			"src/a.ts": A.replace("export function two() {\n\treturn 2;\n}\n", "").replace(
				"export function one",
				"// scient(SA-AUTH): begin - x\n// scient(SA-AUTH): end\nexport function one",
			),
		});
		expect(await problemsOf(repo)).toContain("removes Oh My Pi's lines with no scient(ID) block");
	});

	it("rejects even a blank line outside a block", async () => {
		const { repo } = setup(AUTH);
		const block = "// scient(SA-AUTH): begin - why\nexport const three = 3;\n// scient(SA-AUTH): end\n";
		const inserted = A.replace("}\nexport function two", `}\n${block}export function two`);
		commit(repo, "scient: mark", { "src/a.ts": inserted });
		expect((await check(repo)).problems).toEqual([]);
		// In YAML or Markdown a blank line can change what the file says.
		commit(repo, "scient: space", { "src/a.ts": inserted.replace("}\n// scient", "}\n\n// scient") });
		expect(await problemsOf(repo)).toContain("src/a.ts:5 changes Oh My Pi's code outside a scient(ID) block");
	});

	it("does not let a line identical to Oh My Pi's hide a removal beside it", async () => {
		const { repo } = setup(AUTH);
		commit(repo, "scient: mark", { "src/a.ts": MARKED_ONE });
		// Restores `return 1;` in place of the block, and also drops Oh My Pi's closing brace.
		commit(repo, "scient: restore", { "src/a.ts": A.replace("\treturn 1;\n}\n", "\treturn 1;\n") });
		expect(await problemsOf(repo)).toContain("src/a.ts:3 removes Oh My Pi's lines with no scient(ID) block there");
	});

	const RETIRED = {
		...BASE_ENTRIES,
		"SA-AUTH": { status: "retired", contract: "Sign-ins.", disposition: "Upstream does this since 1.1." },
	};
	const ROOT = { status: "active", contract: "Root.", upstream: ["src/a.ts"] };
	const ROOT_BLOCK = "\t// scient(SA-ROOT): begin - why\n\tconst x = 1;\n\t// scient(SA-ROOT): end\n";

	it("requires retiring a hook that replaced Oh My Pi's code to restore it", async () => {
		const { repo } = setup(AUTH);
		commit(repo, "scient: mark", { "src/a.ts": MARKED_ONE });
		commit(repo, "scient: retire", {
			"src/a.ts": A.replace("\treturn 1;\n", ""),
			"scripts/scient/divergences.json": ledger(RETIRED),
		});
		expect(await problemsOf(repo)).toContain("src/a.ts:2 removes Oh My Pi's lines with no scient(ID) block there");
	});

	it("covers a removal by the block where it is, whichever entry that block belongs to", async () => {
		// Where blocks sit side by side, which explains which missing line is for review.
		const { repo } = setup({ ...AUTH, "SA-ROOT": ROOT });
		const both = MARKED_ONE.replace("\t// scient(SA-AUTH): end\n", `\t// scient(SA-AUTH): end\n${ROOT_BLOCK}`);
		commit(repo, "scient: mark", { "src/a.ts": both });
		commit(repo, "scient: retire", {
			"src/a.ts": A.replace("\treturn 1;\n", ROOT_BLOCK),
			"scripts/scient/divergences.json": ledger({ ...RETIRED, "SA-ROOT": ROOT }),
		});
		expect((await check(repo)).problems).toEqual([]);
	});

	it("accepts moving a hook to another entry", async () => {
		const { repo } = setup({ ...AUTH, "SA-ROOT": ROOT });
		commit(repo, "scient: mark", { "src/a.ts": MARKED_ONE });
		commit(repo, "scient: move", {
			"src/a.ts": MARKED_ONE.replaceAll("SA-AUTH", "SA-ROOT"),
			"scripts/scient/divergences.json": ledger({ ...RETIRED, "SA-ROOT": ROOT }),
		});
		expect((await check(repo)).problems).toEqual([]);
	});

	it("does not let a copy of Oh My Pi's lines inside a block stand in for them", async () => {
		const { repo } = setup(AUTH);
		// The namespace keeps the copy from redeclaring `two`.
		const copy =
			"// scient(SA-AUTH): begin - why\nnamespace copy {\nexport function two() {\n\treturn 2;\n}\n}\n// scient(SA-AUTH): end\n";
		const copied = A.replace("export function two", `${copy}export function two`);
		commit(repo, "scient: copy", { "src/a.ts": copied });
		expect((await check(repo)).problems).toEqual([]);
		// Drops a line from Oh My Pi's own copy, outside the block.
		const lastReturn = copied.lastIndexOf("\treturn 2;\n");
		commit(repo, "scient: trim", {
			"src/a.ts": copied.slice(0, lastReturn) + copied.slice(lastReturn + "\treturn 2;\n".length),
		});
		expect(await problemsOf(repo)).toContain("removes Oh My Pi's lines with no scient(ID) block there");
	});

	it("does not let a block cover a removal past a generated line", async () => {
		const block = "// scient(SA-AUTH): begin - why\nexport const extra = 1;\n// scient(SA-AUTH): end\n";
		// The accepted alignment carries a block, then a generated line, then Oh My Pi's code.
		const { repo } = setup(AUTH, { "src/a.ts": block + A.replace("'omp'", "'scient'") });
		// Drops Oh My Pi's line after the generated one, outside any block.
		commit(repo, "scient: drop", {
			"src/a.ts": block + A.replace("'omp'", "'scient'").replace("export function one() {\n", ""),
		});
		expect(await problemsOf(repo)).toContain("removes Oh My Pi's lines with no scient(ID) block there");
	});

	it("flags a removal that leaves a missing line beyond a restored one", async () => {
		const block = "// scient(SA-AUTH): begin - why\nexport const extra = 1;\n// scient(SA-AUTH): end\n";
		// The accepted alignment carries the block and a generated line after it.
		const { repo } = setup(AUTH, { "src/a.ts": block + A.replace("'omp'", "'scient'") });
		// Restores the generated line, and drops Oh My Pi's next line with it.
		commit(repo, "scient: restore", { "src/a.ts": block + A.replace("export function one() {\n", "") });
		expect(await problemsOf(repo)).toContain("removes Oh My Pi's lines with no scient(ID) block there");
	});

	it("flags a retirement that leaves Oh My Pi's line missing beside a rewrapped one", async () => {
		// The hook replaced Oh My Pi's first line of one(); a generator turned the next into two lines.
		const hook = "// scient(SA-AUTH): begin - why\nexport function uno() {\n// scient(SA-AUTH): end\n";
		const hooked = A.replace("export function one() {\n\treturn 1;", `${hook}\treturn (\n\t\t1);`);
		const { repo } = setup(AUTH, { "src/a.ts": hooked });
		commit(repo, "scient: retire", {
			"src/a.ts": hooked.replace(hook, ""),
			"scripts/scient/divergences.json": ledger(RETIRED),
		});
		expect(await problemsOf(repo)).toContain("removes Oh My Pi's lines with no scient(ID) block there");
	});

	it("cannot tell a retirement right beside a generated line from a deletion, so flags it", async () => {
		// Such a hook is retired at the next alignment, by leaving its contract out of the replay.
		// The accepted alignment carries the generated line.
		const generated = A.replace("'omp'", "'scient'");
		const { repo } = setup(AUTH, { "src/a.ts": generated });
		const added = "// scient(SA-AUTH): begin - why\nexport const extra = 1;\n// scient(SA-AUTH): end\n";
		commit(repo, "scient: mark", {
			"src/a.ts": generated.replace("export function one", `${added}export function one`),
		});
		commit(repo, "scient: retire", {
			"src/a.ts": generated,
			"scripts/scient/divergences.json": ledger({
				...BASE_ENTRIES,
				"SA-AUTH": { status: "retired", contract: "Sign-ins.", disposition: "Not needed." },
			}),
		});
		expect(await problemsOf(repo)).toContain("src/a.ts:1 removes Oh My Pi's lines with no scient(ID) block there");
	});

	it("checks what a ledger-only retirement stops covering", async () => {
		const prompt = { status: "active", contract: "c", unmarked: { "src/prompt.md": "Sent to the model as is." } };
		const { repo } = setup({ ...BASE_ENTRIES, "SA-PROMPT": prompt });
		commit(repo, "scient: prompt", { "src/prompt.md": "You are Scient Agent.\n" });
		commit(repo, "scient: retire the prompt registration only", {
			"scripts/scient/divergences.json": ledger({
				...BASE_ENTRIES,
				"SA-PROMPT": { ...prompt, status: "retired", disposition: "Gone." },
			}),
		});
		expect(await problemsOf(repo)).toContain("(drops the unmarked registration of src/prompt.md)");

		const relay = { status: "active", contract: "c", json: { "config.json": ["/nested/port"] } };
		const json = setup({ ...BASE_ENTRIES, "SA-RELAY": relay });
		commit(json.repo, "scient: port", { "config.json": CONFIG.replace("9224", "9324") });
		commit(json.repo, "scient: retire the port registration only", {
			"scripts/scient/divergences.json": ledger({
				...BASE_ENTRIES,
				"SA-RELAY": { ...relay, status: "retired", disposition: "Gone." },
			}),
		});
		expect(await problemsOf(json.repo)).toContain(
			"drops the registration of config.json /nested/port, but /nested/port still differs from Oh My Pi",
		);
	});

	it("accepts a ledger change that marks what it stops registering", async () => {
		const entry = { status: "active", contract: "c", unmarked: { "src/a.ts": "Before markers." } };
		const { repo } = setup({ ...BASE_ENTRIES, "SA-AUTH": entry });
		commit(repo, "scient: change", { "src/a.ts": A.replace("\treturn 1;", "\treturn 10;") });
		commit(repo, "scient: mark instead", {
			"src/a.ts": MARKED_ONE,
			"scripts/scient/divergences.json": ledger(AUTH),
		});
		expect((await check(repo)).problems).toEqual([]);
	});

	it("accepts a whole-file registration taking over a JSON pointer's", async () => {
		const relay = { status: "active", contract: "c", json: { "config.json": ["/nested/port"] } };
		const { repo } = setup({ ...BASE_ENTRIES, "SA-RELAY": relay });
		commit(repo, "scient: port", { "config.json": CONFIG.replace("9224", "9324") });
		commit(repo, "scient: register the whole file", {
			"scripts/scient/divergences.json": ledger({
				...BASE_ENTRIES,
				"SA-RELAY": { status: "active", contract: "c", unmarked: { "config.json": "Rewritten as a whole." } },
			}),
		});
		expect((await check(repo)).problems).toEqual([]);
	});

	it("accepts retiring a hook: removing a whole block restores Oh My Pi's code", async () => {
		const { repo } = setup(AUTH);
		commit(repo, "scient: mark", { "src/a.ts": MARKED_ONE });
		commit(repo, "scient: retire", {
			"src/a.ts": A,
			"scripts/scient/divergences.json": ledger({
				...BASE_ENTRIES,
				"SA-AUTH": { status: "retired", contract: "Sign-ins.", disposition: "Upstream does this since 1.1." },
			}),
		});
		expect((await check(repo)).problems).toEqual([]);
	});

	it("rejects a new marker of a retired entry", async () => {
		const { repo } = setup({
			...BASE_ENTRIES,
			"SA-AUTH": { status: "retired", contract: "c", disposition: "Gone." },
		});
		commit(repo, "scient: mark", { "src/a.ts": MARKED_ONE });
		expect(await problemsOf(repo)).toContain("SA-AUTH, which is not an active ledger entry");
	});

	it("rejects a marker whose entry does not list the file", async () => {
		const { repo } = setup({
			...BASE_ENTRIES,
			"SA-AUTH": { status: "active", contract: "c", owned: ["src/auth.ts"] },
		});
		commit(repo, "scient: mark", { "src/auth.ts": "export {};\n", "src/a.ts": MARKED_ONE });
		expect(await problemsOf(repo)).toContain("carries SA-AUTH markers but SA-AUTH does not list it");
	});

	it("requires a deleted Oh My Pi file to be registered", async () => {
		const { repo } = setup();
		commit(repo, "scient: drop CI", { ".github/workflows/ci.yml": null });
		expect(await problemsOf(repo)).toContain("no entry lists as deleted");

		const registered = setup({
			...BASE_ENTRIES,
			"SA-CI": { status: "active", contract: "c", deleted: [".github/workflows/ci.yml"] },
		});
		commit(registered.repo, "scient: drop CI", { ".github/workflows/ci.yml": null });
		expect((await check(registered.repo)).problems).toEqual([]);
	});

	it("allows only registered JSON pointers, and retiring one", async () => {
		const relay = { status: "active", contract: "c", json: { "config.json": ["/nested/port"] } };
		const { repo } = setup({ ...BASE_ENTRIES, "SA-RELAY": relay });
		commit(repo, "scient: port", { "config.json": CONFIG.replace("9224", "9324") });
		expect((await check(repo)).problems).toEqual([]);
		commit(repo, "scient: retire the port", {
			"config.json": CONFIG,
			"scripts/scient/divergences.json": ledger({
				...BASE_ENTRIES,
				"SA-RELAY": { ...relay, status: "retired", disposition: "Upstream moved its port." },
			}),
		});
		expect((await check(repo)).problems).toEqual([]);
		commit(repo, "scient: name", { "config.json": CONFIG.replace('"omp"', '"x"') });
		expect(await problemsOf(repo)).toContain("config.json changes /name");
	});

	it("requires retiring a JSON registration to restore Oh My Pi's value", async () => {
		const relay = { status: "active", contract: "c", json: { "config.json": ["/nested/port"] } };
		const { repo } = setup({ ...BASE_ENTRIES, "SA-RELAY": relay });
		commit(repo, "scient: port", { "config.json": CONFIG.replace("9224", "9324") });
		commit(repo, "scient: retire the registration only", {
			"config.json": CONFIG.replace("9224", "9325"),
			"scripts/scient/divergences.json": ledger({
				...BASE_ENTRIES,
				"SA-RELAY": { ...relay, status: "retired", disposition: "Upstream moved its port." },
			}),
		});
		expect(await problemsOf(repo)).toContain("config.json changes /nested/port");
	});

	it("accepts an unmarked file only with a reason", async () => {
		const entries = {
			...BASE_ENTRIES,
			"SA-PROMPT": { status: "active", contract: "c", unmarked: { "src/prompt.md": "Sent to the model as is." } },
		};
		const { repo } = setup(entries);
		commit(repo, "scient: prompt", { "src/prompt.md": "You are Scient Agent.\n" });
		expect((await check(repo)).problems).toEqual([]);
	});

	it("rejects hand edits to generated RPC clients", async () => {
		const { repo } = setup();
		commit(repo, "scient: wire", { [WIRE]: "export type Wire = 2;\n" });
		expect(await problemsOf(repo)).toContain("regenerate it in a Scient-Generator: rpc commit");
	});

	it("rejects moving a generated RPC client away, even as a registered deletion", async () => {
		const { repo } = setup({ ...BASE_ENTRIES, "SA-WIRE": { status: "active", contract: "c", deleted: [WIRE] } });
		commit(repo, "scient: move the wire", { [WIRE]: null, "scripts/scient/wire.ts": "export type Wire = 1;\n" });
		expect(await problemsOf(repo)).toContain(`changes the generated ${WIRE}`);
	});

	it("rejects an unregistered mode change and binary change", async () => {
		const { repo } = setup();
		git(repo, "update-index", "--chmod=+x", "src/a.ts");
		git(repo, "commit", "-q", "-m", "scient: executable");
		expect(await problemsOf(repo)).toContain("changes the mode or type of Oh My Pi's src/a.ts");

		const binary = setup();
		commit(binary.repo, "scient: logo", { "src/logo.bin": new Uint8Array([0, 9, 9, 9, 0, 255]) });
		expect(await problemsOf(binary.repo)).toContain("binary src/logo.bin");
	});

	it("reads file names literally", async () => {
		const { repo } = setup({ ...BASE_ENTRIES, "SA-NAMES": { status: "active", contract: "c", owned: ["src/é.ts"] } });
		commit(repo, "scient: add", { "src/é.ts": "export {};\n" });
		expect((await check(repo)).problems).toEqual([]);
	});

	it("requires an owner for every file Scient adds", async () => {
		const { repo } = setup();
		commit(repo, "scient: add", { "src/scient/new.ts": "export {};\n" });
		expect(await problemsOf(repo)).toContain("src/scient/new.ts: added by Scient but owned by no entry");
	});

	it("checks from the recorded checkpoint, so restoring the accepted tree hides nothing", async () => {
		const { repo } = setup(AUTH);
		commit(repo, "scient: unmarked", { "src/a.ts": A.replace("return 2", "return 3") });
		commit(repo, "scient: restore", { "src/a.ts": A });
		const result = await check(repo);
		expect(result.commits).toBe(2);
		expect(result.problems.join("\n")).toContain("outside a scient(ID) block");
	});

	it("requires an annotated tag that records its checkpoint", async () => {
		const { repo, replay } = setup();
		git(repo, "tag", "-f", "omp-sync/v1.0.0", replay);
		expect(await problemsOf(repo)).toContain("is not annotated");
		git(repo, "tag", "-f", "-a", "omp-sync/v1.0.0", "-m", "no checkpoint", replay);
		expect(await problemsOf(repo)).toContain('records no "Scient-Checkpoint');
		git(repo, "tag", "-d", "omp-sync/v1.0.0");
		expect(await problemsOf(repo)).toContain("tag omp-sync/v1.0.0 is missing");
	});
});

describe("an alignment pull request", () => {
	function replaySetup(generated: (repo: string) => void, extra: Record<string, string> = {}) {
		const { repo, upstream } = setup(BASE_ENTRIES, extra);
		git(repo, "checkout", "-q", "-b", "replay", upstream);
		commit(repo, "scient: add the ledger\n\nScient-Divergence: SA-RELEASE", {
			"scient.json": git(repo, "show", "omp-sync/v1.0.0:scient.json"),
			"scripts/scient/divergences.json": git(repo, "show", "omp-sync/v1.0.0:scripts/scient/divergences.json"),
			...extra,
		});
		generated(repo);
		const replay = git(repo, "rev-parse", "HEAD");
		git(repo, "checkout", "-q", "main");
		// The product pull request imports the replay's tree.
		git(repo, "read-tree", "-u", "--reset", replay);
		git(repo, "commit", "-q", "--allow-empty", "-m", "sync: Oh My Pi 1.0.0");
		return { repo, replay };
	}
	const generatedIdentity = (content: string) => (repo: string) =>
		commit(repo, "scient: regenerate identity (generated)\n\nScient-Generator: identity", { "src/a.ts": content });
	const renamed = A.replace("'omp'", "'scient'");

	it("accepts a generated commit that is exactly its generator's output", async () => {
		const { repo, replay } = replaySetup(generatedIdentity(renamed));
		const result = await check(repo, { replay, regenerate: true });
		expect(result.problems).toEqual([]);
		expect(result.generated).toBe(1);
	});

	it("rejects a generated commit that carries anything else", async () => {
		const { repo, replay } = replaySetup(generatedIdentity(renamed.replace("return 2", "return 3")));
		expect(await problemsOf(repo, { replay, regenerate: true })).toContain(
			"is not exactly the output of the identity generator",
		);
	});

	it("does not let an install script forge a generated commit", async () => {
		// The forged commit is what the generator plus a prepare script would make.
		const hook = `await Bun.write("src/a.ts", (await Bun.file("src/a.ts").text()).replace("return 2", "return 3"))`;
		// A local dependency, so bun writes a lockfile without the network.
		const manifest = JSON.stringify({
			name: "fixture",
			private: true,
			dependencies: { dep: "file:./dep" },
			scripts: { prepare: `bun -e '${hook}'` },
		});
		const dep = JSON.stringify({ name: "dep", version: "1.0.0" });
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "divergence-lock-"));
		repos.push(scratch);
		write(scratch, { "package.json": manifest, "dep/package.json": dep });
		const install = Bun.spawnSync(["bun", "install", "--ignore-scripts"], {
			cwd: scratch,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(install.exitCode).toBe(0);
		const lock = fs.readFileSync(path.join(scratch, "bun.lock"), "utf8");
		const { repo, replay } = replaySetup(generatedIdentity(renamed.replace("return 2", "return 3")), {
			"package.json": manifest,
			"dep/package.json": dep,
			"bun.lock": lock,
			".gitignore": "node_modules/\n",
		});
		expect(await problemsOf(repo, { replay, regenerate: true })).toContain(
			"is not exactly the output of the identity generator",
		);
	});

	it("requires every replayed commit to say what it is", async () => {
		const { repo, replay } = replaySetup(repo =>
			commit(repo, "scient: something", { "scripts/scient/x.ts": "export {};\n" }),
		);
		expect(await problemsOf(repo, { replay })).toContain("names no Scient-Divergence or Scient-Generator");
	});

	it("requires the product to import the replay's tree exactly", async () => {
		const { repo, replay } = replaySetup(() => {});
		commit(repo, "scient: extra", { "scripts/scient/extra.ts": "export {};\n" });
		expect(await problemsOf(repo, { replay })).toContain("HEAD's tree differs from replay");
	});

	it("rejects a merge in the replay", async () => {
		const { repo, upstream } = setup();
		git(repo, "checkout", "-q", "-b", "side", upstream);
		commit(repo, "side\n\nScient-Divergence: SA-RELEASE", { "scripts/scient/side.ts": "export {};\n" });
		git(repo, "checkout", "-q", "-b", "replay", "omp-sync/v1.0.0");
		git(repo, "merge", "-q", "--no-ff", "-m", "merge\n\nScient-Divergence: SA-RELEASE", "side");
		const replay = git(repo, "rev-parse", "HEAD");
		git(repo, "checkout", "-q", "main");
		git(repo, "read-tree", "-u", "--reset", replay);
		git(repo, "commit", "-q", "-m", "sync");
		expect(await problemsOf(repo, { replay })).toContain("a merge commit");
	});
});

describe("the generators' formatter", () => {
	it("runs the oxfmt that fmt:tools names, without the script's hooks", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "divergence-format-"));
		repos.push(dir);
		const sentinel = (name: string) => `bun -e "require('fs').writeFileSync('${name}', '')"`;
		write(dir, {
			"package.json": JSON.stringify({
				scripts: {
					"prefmt:tools": sentinel("pre"),
					"fmt:tools": "oxfmt 'src/*.ts'",
					"postfmt:tools": sentinel("post"),
				},
			}),
			"src/a.ts": "const a = {b:1}\n",
		});
		await formatTools(dir, path.resolve(import.meta.dir, "..", "..", "node_modules", ".bin"));
		expect(fs.readFileSync(path.join(dir, "src/a.ts"), "utf8")).toBe("const a = { b: 1 };\n");
		expect(fs.existsSync(path.join(dir, "pre"))).toBe(false);
		expect(fs.existsSync(path.join(dir, "post"))).toBe(false);
	});

	it("refuses a fmt:tools it does not recognize", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "divergence-format-"));
		repos.push(dir);
		write(dir, { "package.json": JSON.stringify({ scripts: { "fmt:tools": "oxfmt 'src/*.ts' && touch x" } }) });
		await expect(formatTools(dir)).rejects.toThrow("fmt:tools is no longer");
	});
});
