/**
 * A compiled binary extracts its embedded addon into a folder named for the
 * addon's content, under the package version. Scient Agent releases can share
 * one inherited package version, so the version alone cannot keep one build
 * from loading another's addon. Other builds' folders are removed only after
 * they have sat unused for a week. Under a host-assigned root the natives
 * folder is the root's.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import { initLoaderContext } from "../../native/loader-state.js";
import { addonBuildId, cleanupStaleNativeBuilds, withBuildCache } from "../../native/scient/build-cache.js";

const DAY_MS = 24 * 60 * 60_000;
let scratch: string;

beforeEach(() => {
	scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-natives-build-cache-"));
});

afterEach(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

function buildDir(versionDir: string, name: string, idleMs: number): string {
	const dir = path.join(versionDir, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "pi_natives.test.node"), name);
	const used = new Date(Date.now() - idleMs);
	fs.utimesSync(dir, used, used);
	return dir;
}

describe("cleanupStaleNativeBuilds", () => {
	it("removes another build's folder only once it has been idle for a week", () => {
		const current = buildDir(scratch, "aaaaaaaaaaaaaaaa", 30 * DAY_MS);
		const recent = buildDir(scratch, "bbbbbbbbbbbbbbbb", 6 * DAY_MS);
		const stale = buildDir(scratch, "cccccccccccccccc", 8 * DAY_MS);

		const removed = cleanupStaleNativeBuilds({ versionDir: scratch, currentBuildId: "aaaaaaaaaaaaaaaa" });

		expect(removed).toEqual([stale]);
		expect(fs.existsSync(current)).toBe(true);
		expect(fs.existsSync(recent)).toBe(true);
		expect(fs.existsSync(stale)).toBe(false);
	});

	it("leaves files in the version folder alone", () => {
		buildDir(scratch, "aaaaaaaaaaaaaaaa", 0);
		const staged = path.join(scratch, "pi_natives.test.node");
		fs.writeFileSync(staged, "staged");
		const old = new Date(Date.now() - 30 * DAY_MS);
		fs.utimesSync(staged, old, old);

		expect(cleanupStaleNativeBuilds({ versionDir: scratch, currentBuildId: "aaaaaaaaaaaaaaaa" })).toEqual([]);
		expect(fs.existsSync(staged)).toBe(true);
	});

	it("does nothing when the version folder does not exist", () => {
		expect(cleanupStaleNativeBuilds({ versionDir: path.join(scratch, "missing"), currentBuildId: "a" })).toEqual([]);
	});
});

describe("withBuildCache", () => {
	const ADDONS = ["pi_natives.linux-x64-modern.node", "pi_natives.linux-x64-baseline.node", "pi_natives.linux-x64.node"];
	const context = (overrides: { isCompiledBinary?: boolean } = {}) => ({
		isCompiledBinary: true,
		platformTag: "linux-x64",
		versionedDir: path.join(scratch, "natives", "1.0.0"),
		addonFilenames: ADDONS,
		candidates: ["/beside/the/executable/pi_natives.linux-x64.node"],
		...overrides,
	});

	it("extracts into the build's folder and loads only from it, baseline after modern", () => {
		const stale = buildDir(path.join(scratch, "natives", "1.0.0"), "0000000000000000", 8 * DAY_MS);
		const ctx = withBuildCache(context(), { platformTag: "linux-x64", buildId: "1111111111111111" });
		const folder = path.join(scratch, "natives", "1.0.0", "1111111111111111");
		expect(ctx.versionedDir).toBe(folder);
		expect(ctx.candidates).toEqual(ADDONS.map(file => path.join(folder, file)));
		expect(fs.existsSync(stale)).toBe(false);
	});

	it("loads nothing but the embedded addon even without a build id", () => {
		const ctx = withBuildCache(context(), { platformTag: "linux-x64" });
		expect(ctx.versionedDir).toBe(path.join(scratch, "natives", "1.0.0"));
		expect(ctx.candidates).toEqual([]);
	});

	it("leaves the context alone for a binary that embeds no addon for this platform, or for a checkout", () => {
		expect(withBuildCache(context(), null)).toEqual(context());
		expect(withBuildCache(context(), { platformTag: "darwin-arm64", buildId: "1111111111111111" })).toEqual(
			context(),
		);
		const checkout = context({ isCompiledBinary: false });
		expect(withBuildCache(checkout, { platformTag: "linux-x64", buildId: "1111111111111111" })).toEqual(checkout);
	});
});

describe("addonBuildId", () => {
	it("names a build by the content of the addons it embeds", () => {
		const a = { filename: "pi_natives.linux-x64-modern.node", bytes: new Uint8Array([1, 2, 3]) };
		const b = { filename: "pi_natives.linux-x64-baseline.node", bytes: new Uint8Array([4, 5]) };
		expect(addonBuildId([a, b])).toMatch(/^[0-9a-f]{16}$/);
		expect(addonBuildId([a, b])).toBe(addonBuildId([a, b]));
		expect(addonBuildId([a, { ...b, bytes: new Uint8Array([4, 6]) }])).not.toBe(addonBuildId([a, b]));
	});
});

describe("host-assigned root", () => {
	const saved = { root: process.env.SCIENT_AGENT_ROOT, natives: process.env.SCIENT_AGENT_NATIVES_DIR };
	afterEach(() => {
		for (const [name, value] of [
			["SCIENT_AGENT_ROOT", saved.root],
			["SCIENT_AGENT_NATIVES_DIR", saved.natives],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	it("keeps the natives folder inside the root despite a natives override", () => {
		const hostRoot = path.join(scratch, "host-root");
		process.env.SCIENT_AGENT_ROOT = hostRoot;
		process.env.SCIENT_AGENT_NATIVES_DIR = path.join(scratch, "elsewhere");
		expect(initLoaderContext({ isCompiledBinary: true }).versionedDir).toBe(
			path.join(hostRoot, "natives", packageJson.version),
		);
	});
});
