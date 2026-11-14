import { describe, expect, it } from "bun:test";
import { nextVersions, releaseRefusal } from "./release-version";

describe("release version", () => {
	it("follows the latest published release by one patch, minor or major step", () => {
		expect(nextVersions("0.1.9")).toEqual(["0.1.10", "0.2.0", "1.0.0"]);
		for (const version of ["0.1.9", "0.2.0", "1.0.0"]) {
			expect(releaseRefusal(version, { latestPublished: "v0.1.8", tagExists: false })).toBeUndefined();
		}
	});

	it("refuses to skip a number, repeat one or go back", () => {
		for (const version of ["0.1.10", "0.3.0", "0.1.8", "0.1.7"]) {
			expect(releaseRefusal(version, { latestPublished: "v0.1.8", tagExists: false })).toContain(
				"next release is 0.1.9",
			);
		}
	});

	it("reuses a version whose earlier run failed or was never published, but never a tagged one", () => {
		expect(releaseRefusal("0.1.9", { latestPublished: "v0.1.8", tagExists: false })).toBeUndefined();
		expect(releaseRefusal("0.1.9", { latestPublished: "v0.1.8", tagExists: true })).toContain("tagged already");
	});

	it("allows any version before the first published release, and refuses one that is not x.y.z", () => {
		expect(releaseRefusal("0.1.0", { latestPublished: null, tagExists: false })).toBeUndefined();
		expect(releaseRefusal("0.1.9-beta", { latestPublished: "v0.1.8", tagExists: false })).toContain("not x.y.z");
	});
});
