import { describe, expect, it } from "bun:test";
import { applyRenames, missingKeptFiles } from "./rename-identity";

describe("exempted files", () => {
	const KEPT = new Set(["test/control-path.test.ts"]);
	const tree = (files: string[]) => (file: string) => files.includes(file);

	it("accepts every exempted file where it is listed", () => {
		expect(missingKeptFiles(tree(["test/control-path.test.ts"]), KEPT)).toEqual([]);
	});

	it("reports an exempted file that moved, which the rules would otherwise rename", () => {
		expect(missingKeptFiles(tree(["test/ssh/control-path.test.ts"]), KEPT)).toEqual(["test/control-path.test.ts"]);
	});
});

describe("log file names", () => {
	it("renames a log file however the source names it", () => {
		for (const [source, renamed] of [
			[`\`omp.\${day}.\${pid}.log\``, `\`scient-agent.\${day}.\${pid}.log\``],
			[
				"/^omp\\.(\\d{4}-\\d{2}-\\d{2})\\.(\\d+)\\.log$/",
				"/^scient-agent\\.(\\d{4}-\\d{2}-\\d{2})\\.(\\d+)\\.log$/",
			],
			["/omp\\.[\\d-]+\\.\\d+\\.log/", "/scient-agent\\.[\\d-]+\\.\\d+\\.log/"],
			["`logs/omp.<date>.<pid>.log`", "`logs/scient-agent.<date>.<pid>.log`"],
			["`~/.scient-agent/logs/omp.*.log`", "`~/.scient-agent/logs/scient-agent.*.log`"],
		]) {
			expect(applyRenames(source)).toBe(renamed);
		}
	});

	it("leaves names that only look like log files", () => {
		for (const source of ['"omp.hud.todo"', "`omp.<role>`", "`omp.<message>.json`"]) {
			expect(applyRenames(source)).toBe(source);
		}
	});
});
