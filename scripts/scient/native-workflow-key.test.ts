import { describe, expect, it } from "bun:test";
import { nativeWorkflowKey } from "./native-workflow-key";

function fixture() {
	return {
		env: { RUSTFLAGS: "-C opt-level=2" },
		jobs: {
			native: {
				steps: [{ run: "compile" }, { id: "save-native", uses: "actions/cache/save@v6" }, { run: "upload" }],
			},
		},
	};
}

describe("native addon cache key", () => {
	it("reuses compiled addons when only artifact upload changes", () => {
		const workflow = fixture();
		const before = nativeWorkflowKey(workflow);
		workflow.jobs.native.steps[2].run = "upload a different way";
		expect(nativeWorkflowKey(workflow)).toBe(before);
	});

	it("invalidates the cache when the compile command or build environment changes", () => {
		const workflow = fixture();
		const before = nativeWorkflowKey(workflow);
		workflow.jobs.native.steps[0].run = "compile with another toolchain";
		expect(nativeWorkflowKey(workflow)).not.toBe(before);

		const newCommand = nativeWorkflowKey(workflow);
		workflow.env.RUSTFLAGS = "-C opt-level=1";
		expect(nativeWorkflowKey(workflow)).not.toBe(newCommand);
	});

	it("refuses to reuse an addon when the cache save boundary is missing", () => {
		const workflow = fixture();
		workflow.jobs.native.steps.splice(1, 1);
		expect(() => nativeWorkflowKey(workflow)).toThrow("Missing native cache save");
	});
});
