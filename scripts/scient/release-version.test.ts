import { describe, expect, it } from "bun:test";
import { nextVersions, releaseRefusal, releaseVersion, stampedManifest, upstreamRefusal } from "./release-version";

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
		expect(releaseRefusal("0.1.8", { latestPublished: "v0.1.8", tagExists: true })).toContain("tagged already");
		// A tag on the next version with no published release was pushed by hand; the run says to delete it.
		expect(releaseRefusal("0.1.9", { latestPublished: "v0.1.8", tagExists: true })).toContain("delete that tag");
	});

	it("allows any version before the first published release, and refuses one that is not x.y.z", () => {
		expect(releaseRefusal("0.1.0", { latestPublished: null, tagExists: false })).toBeUndefined();
		expect(releaseRefusal("0.1.9-beta", { latestPublished: "v0.1.8", tagExists: false })).toContain("not x.y.z");
	});

	it("releases the version it was given, or else the next patch", () => {
		expect(releaseVersion("0.2.0", "v0.1.8")).toBe("0.2.0");
		expect(releaseVersion(" v0.2.0 ", "v0.1.8")).toBe("0.2.0");
		expect(releaseVersion("", "v0.1.8")).toBe("0.1.9");
		expect(releaseVersion("0.1.0", null)).toBe("0.1.0");
		// Before the first published release there is no next patch to take.
		expect(releaseVersion("", null)).toBeUndefined();
	});

	it("stamps only the product version, keeping scient.json's layout", () => {
		const manifest = `${JSON.stringify(
			{ name: "scient-agent", version: "0.1.8", upstream: { name: "oh-my-pi", version: "18.18.6", commit: "c" } },
			null,
			"\t",
		)}\n`;
		const stamped = stampedManifest(manifest, "0.1.9");
		expect(JSON.parse(stamped)).toEqual({ ...JSON.parse(manifest), version: "0.1.9" });
		expect(stamped).toBe(manifest.replace('"version": "0.1.8"', '"version": "0.1.9"'));
	});

	it("releases each Oh My Pi major as its own Scient Agent major", () => {
		expect(upstreamRefusal("0.1.14", "18.22.0")).toBeUndefined();
		expect(upstreamRefusal("1.0.0", "19.0.1")).toBeUndefined();
		// A blank run's next patch on a new Oh My Pi major: every older Desktop would install it.
		expect(upstreamRefusal("0.1.14", "19.0.1")).toContain("1.0.0");
		expect(upstreamRefusal("2.0.0", "20.0.0")).toContain("no Scient Agent major yet");
	});
});
