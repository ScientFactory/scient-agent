/**
 * Removes the symbol tables and debug information the `local` cargo profile
 * leaves in the native addons, before they are cached and embedded in the
 * executable. Oh My Pi's release addons are stripped the same way at link
 * time (bazel/defs.bzl): non-global symbols and debug info on macOS, every
 * symbol the loader does not need elsewhere. Exports, code, data, unwind
 * tables and the version stamp stay; only names a debugger reads go.
 *
 * Usage: bun scripts/scient/strip-native.ts
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

const nativeDir = path.join(import.meta.dir, "../../packages/natives/native");

/**
 * The command that strips one addon on this platform, or undefined where there
 * is nothing to strip: MSVC keeps debug information in a separate `.pdb`.
 * macOS uses Apple's `strip`, which re-signs a linker-signed addon; rustc's
 * own strip leaves a macOS 12+ dylib that dyld rejects.
 */
export function stripCommand(platform: NodeJS.Platform, file: string): string[] | undefined {
	if (platform === "darwin") return ["strip", "-x", "-S", file];
	if (platform === "linux") return ["strip", "--strip-unneeded", file];
	return undefined;
}

/** The addons a build for this platform installed: `pi_natives.<platform>-<arch>[-<variant>].node`. */
export function hostAddons(files: readonly string[], platform: NodeJS.Platform): string[] {
	return files.filter(file => file.startsWith(`pi_natives.${platform}-`) && file.endsWith(".node")).sort();
}

if (import.meta.main) {
	const addons = hostAddons(await fs.readdir(nativeDir), process.platform);
	if (addons.length === 0) throw new Error(`No ${process.platform} addon in ${nativeDir} to strip`);
	for (const addon of addons) {
		const file = path.join(nativeDir, addon);
		const command = stripCommand(process.platform, file);
		if (!command) {
			console.log(`${addon}: nothing to strip on ${process.platform}`);
			continue;
		}
		const before = (await fs.stat(file)).size;
		// arm64 macOS refuses to load an addon whose signature no longer matches its bytes; the
		// linker signs arm64 addons only, so an Intel one has no signature to keep.
		const signed =
			process.platform === "darwin" && (await $`codesign --verify ${file}`.nothrow().quiet()).exitCode === 0;
		await $`${command}`;
		if (signed) await $`codesign --verify ${file}`;
		const after = (await fs.stat(file)).size;
		console.log(`${addon}: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB`);
	}
}
