/**
 * Formatting for the generators. Oh My Pi's `fmt:tools` script names oxfmt and
 * the files it formats; the generators run that oxfmt directly rather than
 * `bun run fmt:tools`, so no package-script hook (`prefmt:tools`,
 * `postfmt:tools`) can change what a generator writes.
 */
import * as path from "node:path";

/** Formats TypeScript as `bun run fmt:tools` does, without running package scripts. */
export async function formatTools(repoRoot: string, bin = path.join(repoRoot, "node_modules", ".bin")): Promise<void> {
	const manifest = JSON.parse(await Bun.file(path.join(repoRoot, "package.json")).text());
	const script = String(manifest.scripts?.["fmt:tools"] ?? "");
	const match = /^oxfmt((?: '[^']+')+)$/.exec(script);
	if (!match) {
		throw new Error(`fmt:tools is no longer "oxfmt '<glob>' ...": ${script}; update scripts/scient/lib/format.ts`);
	}
	const oxfmt = Bun.which("oxfmt", { PATH: bin });
	if (!oxfmt) throw new Error(`oxfmt is not in ${bin}; run bun install`);
	// oxfmt expands the globs itself, as it does when the script passes them quoted.
	const globs = [...match[1].matchAll(/'([^']+)'/g)].map(glob => glob[1]);
	const child = Bun.spawn([oxfmt, ...globs], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`oxfmt failed:\n${stdout}${stderr}`);
}
