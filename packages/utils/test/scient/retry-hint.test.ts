import { describe, expect, it } from "bun:test";
import { extractRetryHint } from "../../src/fetch-retry";

describe("retry hint of a stated reset time", () => {
	it('reads a quota window that "resets at" a time as the wait until then', () => {
		const resetAt = Date.now() + 4 * 3_600_000;
		const stamp = new Date(resetAt).toISOString().replace(/\.\d+Z$/, "Z");
		const before = Date.now();
		const hint = extractRetryHint(
			undefined,
			`429 Subscription quota exhausted. Your usage window resets at ${stamp}. (type=rate_limit_error param=rate_limit_exceeded)`,
		);

		expect(hint).toBeDefined();
		// The stamp has whole seconds; the wait ends at that second.
		expect(before + (hint as number)).toBeGreaterThan(resetAt - 1_000 - 50);
		expect(before + (hint as number)).toBeLessThanOrEqual(resetAt + 50);
	});
});
