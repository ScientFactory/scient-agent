import { expect, it } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectHostAvx2Support, resolveLocalHostAddon } from "../../../../scripts/host-detect";
import { stampNativeVersion } from "../../../../scripts/stamp-native-version";
import { embeddedAddonFiles } from "../../scripts/embed-native";
import packageJson from "../../package.json" with { type: "json" };

const { platform, arch } = process;
const { filename, x64Variant } = resolveLocalHostAddon({ platform, arch, avx2: detectHostAvx2Support() });
const sourceDir = path.resolve(import.meta.dir, "../../native");
const hostAddon = path.join(sourceDir, filename);

it.skipIf(!existsSync(hostAddon))(
	"a compiled binary rejects a same-version sibling when its embedded addon fails",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "scient-compiled-addon-"));
		try {
			const nativeDir = path.join(root, "native");
			await fs.mkdir(nativeDir);
			for (const file of ["loader-state.js", "version-sentinel.js"]) {
				await fs.copyFile(path.join(sourceDir, file), path.join(nativeDir, file));
			}
			await Bun.write(path.join(root, "package.json"), JSON.stringify({ version: packageJson.version }));
			await Bun.write(
				path.join(nativeDir, filename),
				`invalid addon PI_NATIVES_VERSION_STAMP:${packageJson.version}\0`,
			);
			const files = await embeddedAddonFiles({ platform, arch, nativeDir });
			const entry = path.join(root, "probe.js");
			await Bun.write(
				entry,
				`
import { loadNative, openNativeAddon } from "./native/loader-state.js";
if (process.argv[2]) console.log(openNativeAddon(process.argv[2]).__piNativesBuildVersion());
else loadNative();
`,
			);
			const binary = path.join(root, platform === "win32" ? "probe.exe" : "probe");
			await Bun.build({
				entrypoints: [entry],
				files,
				compile: { outfile: binary, autoloadDotenv: false, autoloadBunfig: false },
			});

			const sibling = path.join(root, filename);
			await fs.copyFile(hostAddon, sibling);
			await stampNativeVersion(sibling, packageJson.version);
			const control = Bun.spawnSync([binary, sibling]);
			expect(control.exitCode).toBe(0);
			expect(control.stdout.toString().trim()).toBe(packageJson.version);
			const child = Bun.spawnSync([binary], {
				env: { ...process.env, SCIENT_AGENT_ROOT: path.join(root, "host"), PI_NATIVE_VARIANT: x64Variant ?? "" },
			});
			expect(child.exitCode).not.toBe(0);
			const error = child.stderr.toString();
			expect(error).toContain("Failed to load pi_natives native addon");
			expect(error).toMatch(/- [^\n]*embedded-[0-9a-f]+[/\\]pi_natives\.[^\n]+\.node:/);
			expect(error).not.toContain(sibling);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
	60_000,
);
