/**
 * Under a host-assigned root the natives folder is the root's, whatever
 * SCIENT_AGENT_NATIVES_DIR says.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import packageJson from "../../package.json" with { type: "json" };
import {
	type EmbeddedAddonFile,
	embeddedAddonPath,
	extractEmbeddedAddons,
	initLoaderContext,
	pruneStaleEmbeddedAddons,
} from "../../native/loader-state.js";

let scratch: string;

beforeEach(() => {
	scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-natives-build-cache-"));
});

afterEach(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
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

it("keeps another build's addon for a week after its last use, including a cache hit", () => {
	const day = 24 * 60 * 60_000;
	const now = Date.now();
	const zstdPath = path.join(scratch, "addon.zst");
	fs.writeFileSync(zstdPath, Bun.zstdCompressSync(Buffer.from("addon")));
	const cached: EmbeddedAddonFile = { variant: "default", filename: "test.node", hash: "aaaa", size: 5, zstdPath };
	const recent = { ...cached, hash: "bbbb" };
	const stale = { ...cached, hash: "cccc" };
	const target = (file: EmbeddedAddonFile) => embeddedAddonPath(scratch, file);
	extractEmbeddedAddons({ files: [cached, recent, stale], targetDir: scratch });
	for (const [file, days] of [
		[cached, 8],
		[recent, 6],
		[stale, 8],
	] as const) {
		const lastUsed = new Date(now - days * day);
		fs.utimesSync(path.dirname(target(file)), lastUsed, lastUsed);
	}

	// One process reuses its existing addon. A different build prunes before the first opens it.
	expect(extractEmbeddedAddons({ files: [cached], targetDir: scratch })).toEqual([]);
	expect(pruneStaleEmbeddedAddons({ targetDir: scratch, keepHashes: ["dddd"] })).toEqual([
		path.dirname(target(stale)),
	]);
	expect(fs.existsSync(target(cached))).toBe(true);
	expect(fs.existsSync(target(recent))).toBe(true);
	expect(fs.existsSync(target(stale))).toBe(false);
});
