import { describe, expect, it } from "bun:test";
import { missingKept } from "./rename-wording";

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
