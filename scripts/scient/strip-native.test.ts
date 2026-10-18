import { describe, expect, it } from "bun:test";
import { hostAddons, stripCommand } from "./strip-native";

describe("native addon stripping", () => {
	it("keeps global symbols on macOS and dynamic symbols on Linux, and leaves Windows alone", () => {
		expect(stripCommand("darwin", "a.node")).toEqual(["strip", "-x", "-S", "a.node"]);
		expect(stripCommand("linux", "a.node")).toEqual(["strip", "--strip-unneeded", "a.node"]);
		expect(stripCommand("win32", "a.node")).toBeUndefined();
	});

	it("strips every addon this platform built, both x86-64 variants included", () => {
		const files = [
			"index.d.ts",
			"pi_natives.linux-x64-modern.node",
			"pi_natives.linux-x64-baseline.node",
			"pi_natives.darwin-arm64.node",
			"version-sentinel.js",
		];
		expect(hostAddons(files, "linux")).toEqual([
			"pi_natives.linux-x64-baseline.node",
			"pi_natives.linux-x64-modern.node",
		]);
		expect(hostAddons(files, "darwin")).toEqual(["pi_natives.darwin-arm64.node"]);
	});
});
