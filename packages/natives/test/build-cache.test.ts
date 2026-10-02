/**
 * A compiled binary extracts its embedded addon into a directory named for the
 * addon's content, under the package version. Scient Agent releases can share
 * one inherited package version, so the version alone cannot keep one build
 * from loading another's addon. Other builds' directories are removed only
 * after they have sat unused for a week.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cleanupStaleNativeBuilds } from "../native/loader-state.js";

const DAY_MS = 24 * 60 * 60_000;
let versionDir: string | undefined;

afterEach(() => {
	if (versionDir) fs.rmSync(versionDir, { recursive: true, force: true });
	versionDir = undefined;
});

function buildDir(name: string, idleMs: number): string {
	versionDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "pi-natives-build-cache-"));
	const dir = path.join(versionDir, name);
	fs.mkdirSync(dir);
	fs.writeFileSync(path.join(dir, "pi_natives.test.node"), name);
	const used = new Date(Date.now() - idleMs);
	fs.utimesSync(dir, used, used);
	return dir;
}

describe("cleanupStaleNativeBuilds", () => {
	it("removes another build's directory only once it has been idle for a week", () => {
		const current = buildDir("aaaaaaaaaaaaaaaa", 30 * DAY_MS);
		const recent = buildDir("bbbbbbbbbbbbbbbb", 6 * DAY_MS);
		const stale = buildDir("cccccccccccccccc", 8 * DAY_MS);

		const removed = cleanupStaleNativeBuilds({ versionDir: versionDir!, currentBuildId: "aaaaaaaaaaaaaaaa" });

		expect(removed).toEqual([stale]);
		expect(fs.existsSync(current)).toBe(true);
		expect(fs.existsSync(recent)).toBe(true);
		expect(fs.existsSync(stale)).toBe(false);
	});

	it("leaves files in the version directory alone", () => {
		buildDir("aaaaaaaaaaaaaaaa", 0);
		const staged = path.join(versionDir!, "pi_natives.test.node");
		fs.writeFileSync(staged, "staged");
		const old = new Date(Date.now() - 30 * DAY_MS);
		fs.utimesSync(staged, old, old);

		expect(cleanupStaleNativeBuilds({ versionDir: versionDir!, currentBuildId: "aaaaaaaaaaaaaaaa" })).toEqual([]);
		expect(fs.existsSync(staged)).toBe(true);
	});

	it("does nothing when the version directory does not exist", () => {
		expect(
			cleanupStaleNativeBuilds({ versionDir: path.join(os.tmpdir(), "pi-natives-missing"), currentBuildId: "a" }),
		).toEqual([]);
	});
});
