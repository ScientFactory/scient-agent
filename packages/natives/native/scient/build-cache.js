/**
 * Scient Agent's native addon cache.
 *
 * Scient Agent releases can share one inherited package version, so the version
 * alone cannot keep one build from loading another's addon. A compiled binary
 * therefore extracts its embedded addons into a folder named for their content,
 * inside the package version's folder, and loads only from that folder: the
 * selected addon, then upstream's fallback to the baseline addon of the same
 * build. An addon found by its file name beside the executable or in a shared
 * folder is not a fallback. Other builds' folders are removed once they have
 * sat unused for a week. Under a host-assigned root the natives folder is the
 * root's.
 *
 * `loader-state.js` takes its natives folder from `hostNativesDir` and hands its
 * context to `withBuildCache` before loading; `scripts/embed-native.ts` names
 * each build with `addonBuildId`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** How long another build's folder may sit unused before it is removed. */
const IDLE_BUILD_MS = 7 * 24 * 60 * 60_000;

/**
 * The natives folder inside a host-assigned `SCIENT_AGENT_ROOT`, or undefined.
 * The same rule as pi-utils' `scient/root.ts`, which this loader cannot import.
 *
 * @returns {string | undefined}
 */
export function hostNativesDir() {
	const root = process.env.SCIENT_AGENT_ROOT;
	return root && path.isAbsolute(root) ? path.join(root, "natives") : undefined;
}

/**
 * A build's id: a hash of the addon files it embeds.
 *
 * @param {ReadonlyArray<{ filename: string; bytes: Uint8Array }>} files
 * @returns {string}
 */
export function addonBuildId(files) {
	const hash = new Bun.CryptoHasher("sha256");
	for (const { filename, bytes } of files) {
		hash.update(filename);
		hash.update(bytes);
	}
	return hash.digest("hex").slice(0, 16);
}

/**
 * The loader context for a compiled binary that embeds its addon: it extracts
 * into its build's folder, and its candidates are upstream's file names in that
 * folder, so a modern addon that fails to load falls back to the same build's
 * baseline one. Without a build id it has no candidates but the addon it
 * extracts. Any other context is returned as it is.
 *
 * @template {{ isCompiledBinary: boolean; platformTag: string; versionedDir: string; addonFilenames: string[]; candidates: string[] }} T
 * @param {T} ctx
 * @param {{ platformTag: string; buildId?: string } | null} addon
 * @returns {T}
 */
export function withBuildCache(ctx, addon) {
	if (!ctx.isCompiledBinary || addon?.platformTag !== ctx.platformTag) return ctx;
	if (!addon.buildId) return { ...ctx, candidates: [] };
	const versionDir = ctx.versionedDir;
	try {
		// Version cleanup reads this folder's timestamp, which extracting into a
		// build folder inside it does not refresh.
		fs.mkdirSync(versionDir, { recursive: true });
		const now = new Date();
		fs.utimesSync(versionDir, now, now);
	} catch {
		// Extraction reports a folder that cannot be created.
	}
	cleanupStaleNativeBuilds({ versionDir, currentBuildId: addon.buildId });
	const buildDir = path.join(versionDir, addon.buildId);
	return { ...ctx, versionedDir: buildDir, candidates: ctx.addonFilenames.map(file => path.join(buildDir, file)) };
}

/**
 * Removes other builds' folders under a package version's folder once they have
 * been idle for a week. Every start refreshes its own folder's timestamp, so
 * builds in regular use (a stable app beside a development one) keep theirs.
 * Best-effort, like the loader's version cleanup.
 *
 * @param {{ versionDir: string; currentBuildId: string }} input
 * @returns {string[]}
 */
export function cleanupStaleNativeBuilds({ versionDir, currentBuildId }) {
	const removed = [];
	let entries;
	try {
		entries = fs.readdirSync(versionDir, { withFileTypes: true });
	} catch {
		return removed;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === currentBuildId) continue;
		const targetPath = path.join(versionDir, entry.name);
		try {
			if (Date.now() - fs.statSync(targetPath).mtimeMs < IDLE_BUILD_MS) continue;
			fs.rmSync(targetPath, { recursive: true, force: true });
			removed.push(targetPath);
		} catch {
			// Stale caches are opportunistic cleanup only.
		}
	}
	return removed;
}
