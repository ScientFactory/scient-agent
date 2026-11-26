import { describe, expect, it } from "bun:test";
import { nativeWorkflowKey } from "./native-workflow-key";

function fixture() {
	const producer = () => ({
		needs: "version",
		steps: [{ run: "compile" }, { id: "save-native", uses: "actions/cache/save@v6" }, { run: "qualify" }],
	});
	return {
		env: { RUSTFLAGS: "-C opt-level=2" },
		jobs: {
			version: { needs: "prepare", steps: [{ run: "select version" }] },
			prepare: { steps: [{ run: "prepare" }] },
			build: producer(),
			"natives-linux": producer(),
			release: { needs: "build", steps: [{ run: "release" }] },
		},
	};
}

describe("native addon cache key", () => {
	it("reuses compiled addons when only later checks or a release job change", () => {
		const workflow = fixture();
		const before = nativeWorkflowKey(workflow);
		workflow.jobs.build.steps.push({ run: "check startup" });
		workflow.jobs.release.steps.push({ run: "check signed binary" });
		expect(nativeWorkflowKey(workflow)).toBe(before);
	});

	it("invalidates the shared key for either producer, prerequisites, or build settings", () => {
		for (const id of ["build", "natives-linux", "version", "prepare"] as const) {
			const workflow = fixture();
			const before = nativeWorkflowKey(workflow);
			workflow.jobs[id].steps.unshift({ run: "change build input" });
			expect(nativeWorkflowKey(workflow)).not.toBe(before);
		}
		const workflow = fixture();
		const before = nativeWorkflowKey(workflow);
		workflow.env.RUSTFLAGS = "-C opt-level=1";
		expect(nativeWorkflowKey(workflow)).not.toBe(before);
	});

	it("refuses to reuse an addon when the cache save boundary is missing", () => {
		const workflow = fixture();
		workflow.jobs.build.steps.splice(1, 1);
		expect(() => nativeWorkflowKey(workflow)).toThrow("Missing native cache save in build");
	});
});
