import { describe, expect, it } from "bun:test";
import { judge } from "./upstream-tests";

// Shaped as `scripts/ci-test-ts.ts <mode> --full` prints a failed run, with
// Bun 1.4's own output inside each chunk.
const LABEL = "packages/coding-agent (native/tooling/browser/unit bucket; 917 files; parallel=1 chunk 73/92; 10 files)";
const FILE = "test/tools/browser-tab-worker-startup.test.ts";
const KNOWN_NAME = "browser tabs whose renderer crashed > cancels";
const KNOWN = new Set([`packages/coding-agent/${FILE} > ${KNOWN_NAME}`]);

const failure = (name: string) => [
	"error: expect(received).toBe(expected)",
	"",
	"Expected: 0",
	"Received: 1",
	`(fail) ${name} [2511.40ms]`,
];
const summary = (pass: number, fail: number, extra: string[] = []) => [
	"",
	` ${pass} pass`,
	` ${fail} fail`,
	...extra,
	" 236 expect() calls",
	`Ran ${pass + fail} tests across 10 files. [145.80s]`,
];
const chunk = (label: string, exit: number, body: string[]) => [
	`==> [73/92] ${label} (FAILED exit ${exit}, 145.8s)`,
	"$ bun test test/tools/browser-tab-call.test.ts --parallel=1 --timeout=30000",
	"bun test v1.4.2 (744846f84) 1x PARALLEL",
	...body,
];
function run(chunks: string[][], failed = chunks.length): string {
	return [
		`==> [72/92] packages/coding-agent (native/tooling/browser/unit bucket; chunk 72/92) (ok, 62.2s)`,
		"$ bun test test/tools/browser-tab-call.test.ts --parallel=1 --timeout=30000",
		...chunks.flat(),
		"",
		`${failed} of 92 test chunk(s) FAILED`,
	].join("\n");
}
const knownOnly = chunk(LABEL, 1, ["", `${FILE}:`, ...failure(KNOWN_NAME), ...summary(110, 1)]);

describe("a failed bucket", () => {
	it("passes when every failure is a known upstream failure", () => {
		expect(judge(1, run([knownOnly]), KNOWN)).toEqual({
			known: [`packages/coding-agent/${FILE} > ${KNOWN_NAME}`],
			problems: [],
		});
	});

	it("ignores Bun's closing list of the failures it already reported", () => {
		const body = ["", `${FILE}:`, ...failure(KNOWN_NAME), "", "1 tests failed:", `(fail) ${KNOWN_NAME}`];
		expect(judge(1, run([chunk(LABEL, 1, [...body, ...summary(110, 1)])]), KNOWN).problems).toEqual([]);
	});

	it("fails when a test file threw while loading beside a known failure", () => {
		const body = [
			"",
			`${FILE}:`,
			...failure(KNOWN_NAME),
			"",
			"test/tools/browser-targets.test.ts:",
			"",
			"# Unhandled error between tests",
			"-------------------------------",
			"error: init broke",
			"-------------------------------",
			...summary(109, 2, [" 1 error"]),
		];
		expect(judge(1, run([chunk(LABEL, 1, body)]), KNOWN).problems).toEqual([
			`${LABEL}: an error outside any test`,
			`${LABEL}: Bun counted 1 errors outside tests`,
			`${LABEL}: Bun counted 2 failures and named 1`,
		]);
	});

	it("fails on any test it does not list", () => {
		const other = chunk("packages/mnemopi", 1, [
			"",
			"test/embeddings.test.ts:",
			...failure("sends a User-Agent"),
			...summary(6, 1),
		]);
		expect(judge(1, run([knownOnly, other]), KNOWN).problems).toEqual([
			"failed: packages/mnemopi/test/embeddings.test.ts > sends a User-Agent",
		]);
	});

	it("fails when a chunk was killed, crashed or did not finish", () => {
		const killed = chunk(LABEL, 137, ["", `${FILE}:`, ...failure(KNOWN_NAME)]);
		expect(judge(1, run([killed]), KNOWN).problems).toEqual([`${LABEL}: exited 137, not with failed tests`]);
		const cut = chunk(LABEL, 1, ["", `${FILE}:`, ...failure(KNOWN_NAME)]);
		expect(judge(1, run([cut]), KNOWN).problems).toEqual([`${LABEL}: Bun did not finish its report`]);
	});

	it("fails when a failure cannot be placed in a test file", () => {
		const body = [...failure(KNOWN_NAME), ...summary(110, 1)];
		expect(judge(1, run([chunk(LABEL, 1, body)]), KNOWN).problems).toEqual([
			`failed: packages/coding-agent: ${KNOWN_NAME}`,
		]);
	});

	it("fails when the run's report is incomplete or missing", () => {
		expect(judge(1, run([knownOnly], 2), KNOWN).problems).toEqual([
			"the runner says 2 chunks failed; 1 were reported",
		]);
		// The sequential path, or a runner that never started, prints no summary.
		expect(judge(1, "error: Unknown mode: definitely-not-a-mode", KNOWN).problems).toEqual([
			"the runner printed no failure summary",
		]);
		expect(judge(2, run([knownOnly]), KNOWN).problems).toEqual(["the runner exited 2, not with failed tests"]);
	});
});
