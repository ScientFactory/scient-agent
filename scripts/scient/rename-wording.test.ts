import { describe, expect, it } from "bun:test";
import { coverSecurityScanStart, missingKept, researchWording } from "./rename-wording";

describe("prompt perturbation coverage", () => {
	const source = "`start`: plan → background Scient Agent job.";
	const prompt = `# Actions\n${source}\n`;
	const original = { source: "Other line", origin: "other.md", variants: ["Another line"] };

	it("adds a match for the lengthened prompt once and preserves an upstream pool entry if one arrives", () => {
		const result = coverSecurityScanStart(JSON.stringify({ entries: [original] }), prompt);
		const [other, added] = JSON.parse(result).entries;
		expect(other).toEqual(original);
		expect(added.source).toBe(source);
		expect(added.origin).toBe("tools/security-scan.md");
		expect(new Set(added.variants).size).toBeGreaterThan(1);
		expect(coverSecurityScanStart(result, prompt)).toBe(result);

		const upstream = JSON.stringify({ entries: [{ ...added, variants: ["An upstream paraphrase."] }] });
		expect(coverSecurityScanStart(upstream, prompt)).toBe(upstream);
	});

	it("reports the prompt and stale line before adding a pool entry", () => {
		for (const changed of [undefined, `${source} More text.`]) {
			expect(() => coverSecurityScanStart('{"entries":[]}', changed)).toThrow(
				`tools/security-scan.md: missing ${source}`,
			);
		}
	});
});

describe("kept sentences", () => {
	const KEPT = {
		"src/exit.ts": ["Previous OMP process exited."],
		"test/exit.test.ts": ["Previous OMP process exited."],
	};
	const tree = (files: Record<string, string>) => (file: string) => files[file];

	it("accepts every kept sentence where it is listed", () => {
		const read = tree({
			"src/exit.ts": 'const MESSAGE = "Previous OMP process exited.";',
			"test/exit.test.ts": 'expect(message).toBe("Previous OMP process exited.");',
		});
		expect(missingKept(read, KEPT)).toEqual([]);
	});

	it("reports a kept sentence whose file moved, even when nothing else names the product", () => {
		// Upstream moved both files: the rewrite would never see the listed paths.
		const read = tree({ "src/session/exit.ts": 'const MESSAGE = "Previous OMP process exited.";' });
		expect(missingKept(read, KEPT)).toEqual([
			"src/exit.ts (no such file): Previous OMP process exited.",
			"test/exit.test.ts (no such file): Previous OMP process exited.",
		]);
	});

	it("reports a kept sentence that changed", () => {
		const read = tree({
			"src/exit.ts": 'const MESSAGE = "The previous process exited.";',
			"test/exit.test.ts": 'expect(message).toBe("Previous OMP process exited.");',
		});
		expect(missingKept(read, KEPT)).toEqual(["src/exit.ts: Previous OMP process exited."]);
	});
});

describe("research-audience wording", () => {
	const base = "packages/coding-agent/src/prompts/system/";
	const cases = [
		[
			"system-prompt.md",
			"You are omp's trusted coding assistant.",
			"You are Scient's trusted research and coding assistant.",
		],
		[
			"personalities/default.md",
			"- Assume technical reader; don't narrate obvious steps or over-explain basics.",
			"- Match the reader's expertise; explain unfamiliar concepts when needed.",
		],
		[
			"personalities/friendly.md",
			"- MUST assume reader technical; warmth NEVER means dumbing down.",
			"- Match the reader's expertise; warmth NEVER means sacrificing precision.",
		],
		["personalities/pragmatic.md", "- MUST assume reader technical.", "- Match the reader's expertise."],
	];
	const wrap = (sentence: string) => `before\n${sentence}\nafter`;
	const fixture = () => Object.fromEntries(cases.map(([file, from]) => [base + file, wrap(from)]));

	for (const [file, from, to] of cases) {
		it(`rewrites only the accepted sentence in ${file} and is idempotent`, () => {
			const files = fixture();
			const result = researchWording(file => files[file]);
			expect(result.get(base + file)).toBe(wrap(to));
			expect(researchWording(file => result.get(file))).toEqual(result);
		});

		it(`stops with the file and sentence when ${file} moves, changes or is ambiguous`, () => {
			for (const invalid of [
				undefined,
				from.replace(".", "!"),
				`${from}\n${from}`,
				`${to}\n${to}`,
				`${from}\n${to}`,
			]) {
				const files: Record<string, string | undefined> = { ...fixture(), [base + file]: invalid };
				files[base + "moved.md"] = from;
				let message = "";
				try {
					researchWording(file => files[file]);
				} catch (error) {
					message = String(error);
				}
				expect(message).toContain(base + file);
				expect(message).toContain(from.replace("omp's", "Scient Agent's"));
			}
		});
	}

	it("accepts the previously generated role but rejects it alongside another source form", () => {
		const files = fixture();
		const file = base + "system-prompt.md";
		files[file] = "You are Scient's trusted coding assistant.";
		expect(researchWording(file => files[file]).get(file)).toBe(cases[0][2]);
		files[file] += "\nYou are omp's trusted coding assistant.";
		expect(() => researchWording(file => files[file])).toThrow("2 found");
	});
});
