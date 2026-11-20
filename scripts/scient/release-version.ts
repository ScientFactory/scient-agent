#!/usr/bin/env bun
/**
 * Picks the version a release run builds and checks that it may be released
 * now. As in Scient Desktop's release, the version is the run's input, not a
 * commit: a run given no version releases the next patch after the latest
 * published release. A version is used up when its release is published, not
 * when a build of it is drafted or fails: it must come right after the latest
 * published release, and no tag may carry it yet (publishing a draft creates
 * its tag). An unpublished draft holds no tag, so the next release run of the
 * same version replaces it.
 *
 *   GITHUB_REPOSITORY=ScientFactory/scient-agent RELEASE_VERSION=0.2.0 bun scripts/scient/release-version.ts
 *
 * Prints the version and writes `version=<version>` to `$GITHUB_OUTPUT` when it
 * is set; exits 1 with the reason when the version may not be released.
 *
 *   bun scripts/scient/release-version.ts --stamp 0.2.0
 *
 * Writes the version into this checkout's `scient.json`, so the executable
 * built next reports it. A release run stamps each build; nothing commits it.
 */
import { appendFileSync } from "node:fs";
import * as path from "node:path";
import { $ } from "bun";

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** The versions that may follow `latest`: its next patch, minor and major release. */
export function nextVersions(latest: string): string[] {
	const match = VERSION.exec(latest);
	if (!match) throw new Error(`${latest} is not a version (x.y.z)`);
	const [major, minor, patch] = match.slice(1).map(Number);
	return [`${major}.${minor}.${patch + 1}`, `${major}.${minor + 1}.0`, `${major + 1}.0.0`];
}

/**
 * The version a release run builds: the one it was given, or the next patch after
 * `latestPublished` (a tag such as `v0.1.8`). Undefined when neither exists.
 */
export function releaseVersion(requested: string, latestPublished: string | null): string | undefined {
	const version = requested.trim().replace(/^v/, "");
	if (version) return version;
	return latestPublished === null ? undefined : nextVersions(latestPublished.replace(/^v/, ""))[0];
}

export interface ReleaseState {
	/** The latest published release's tag (`v0.1.8`), or null before the first one. */
	latestPublished: string | null;
	/** Whether a tag `v<version>` exists already. */
	tagExists: boolean;
}

/** Why `version` may not be released in `state`, or undefined when it may. */
export function releaseRefusal(version: string, state: ReleaseState): string | undefined {
	if (!VERSION.test(version)) return `The version ${version} is not x.y.z.`;
	const latest = state.latestPublished?.replace(/^v/, "") ?? null;
	const next = latest === null ? null : nextVersions(latest);
	if (state.tagExists) {
		// Only publishing tags a version now, so a tag on the next version with no published
		// release was made another way (a pushed tag, as releases were once made).
		if (next?.includes(version)) {
			return `v${version} is tagged, but no release of it is published. A release run never tags; delete that tag, then run the release again.`;
		}
		return `v${version} is tagged already, and a tagged version is never released again. Release the version after the latest published release.`;
	}
	if (next === null || next.includes(version)) return undefined;
	return `The latest published release is v${latest}, so the next release is ${next.join(", ")} (patch, minor or major), not ${version}.`;
}

/**
 * The Scient Agent major each Oh My Pi major ships as. Scient Desktop accepts a product major only once
 * it is qualified against that Oh My Pi major, and a Desktop from before then installs nothing past its
 * own ceiling, the next product major: a build on a new Oh My Pi major released in the old product
 * major would be installed by every such Desktop and then refused. An alignment to a new Oh My Pi
 * major adds its row once Scient Desktop accepts it.
 */
export const PRODUCT_MAJOR_BY_UPSTREAM_MAJOR: Readonly<Record<number, number>> = { 18: 0, 19: 1 };

/** Why `version` may not be released for a build on Oh My Pi `upstream`, or undefined when it may. */
export function upstreamRefusal(version: string, upstream: string): string | undefined {
	const upstreamMajor = Number(upstream.split(".")[0]);
	const productMajor = PRODUCT_MAJOR_BY_UPSTREAM_MAJOR[upstreamMajor];
	if (productMajor === undefined) {
		return `This build is on Oh My Pi ${upstream}, whose major has no Scient Agent major yet; add it to PRODUCT_MAJOR_BY_UPSTREAM_MAJOR once Scient Desktop accepts it.`;
	}
	if (Number(version.split(".")[0]) === productMajor) return undefined;
	return `This build is on Oh My Pi ${upstream}, which Scient Agent releases as ${productMajor}.x, not ${version}; give the run the first ${productMajor}.x version after the latest published release (${productMajor}.0.0 when that starts the major).`;
}

/** `scient.json`'s text with `version` as the product version, its layout unchanged. */
export function stampedManifest(manifest: string, version: string): string {
	const scient = JSON.parse(manifest) as { version: string };
	scient.version = version;
	return `${JSON.stringify(scient, null, "\t")}\n`;
}

/** `gh` output, or null when GitHub answers 404; any other failure throws, so the check fails closed. */
async function ghOrNotFound(args: string[]): Promise<string | null> {
	const result = await $`gh ${args}`.nothrow().quiet();
	if (result.exitCode === 0) return result.text().trim();
	const stderr = result.stderr.toString();
	if (stderr.includes("HTTP 404")) return null;
	throw new Error(`gh ${args.join(" ")} failed: ${stderr.trim()}`);
}

async function stamp(version: string | undefined): Promise<void> {
	if (!version || !VERSION.test(version)) {
		console.error(`--stamp needs a version (x.y.z), not ${version ?? "nothing"}.`);
		process.exit(2);
	}
	const file = path.resolve(import.meta.dir, "..", "..", "scient.json");
	await Bun.write(file, stampedManifest(await Bun.file(file).text(), version));
	console.log(`scient.json now reports ${version}.`);
}

async function check(): Promise<void> {
	const repo = process.env.GITHUB_REPOSITORY;
	if (!repo) {
		console.error("GITHUB_REPOSITORY is not set.");
		process.exit(2);
	}
	const latestPublished = await ghOrNotFound(["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"]);
	const version = releaseVersion(process.env.RELEASE_VERSION ?? "", latestPublished);
	if (version === undefined) {
		console.log("::error::No release is published yet, so give the run the first version to release.");
		process.exitCode = 1;
		return;
	}
	const tagExists = (await ghOrNotFound(["api", `repos/${repo}/git/ref/tags/v${version}`, "--jq", ".ref"])) !== null;
	const scient = (await Bun.file(path.resolve(import.meta.dir, "..", "..", "scient.json")).json()) as {
		upstream: { version: string };
	};
	const refusal =
		releaseRefusal(version, { latestPublished, tagExists }) ?? upstreamRefusal(version, scient.upstream.version);
	if (refusal) {
		console.log(`::error::${refusal}`);
		process.exitCode = 1;
		return;
	}
	console.log(`Releasing ${version}; the latest published release is ${latestPublished ?? "none"}.`);
	const output = process.env.GITHUB_OUTPUT;
	if (output) appendFileSync(output, `version=${version}\n`);
}

if (import.meta.main) {
	const [flag, value] = process.argv.slice(2);
	if (flag === "--stamp") await stamp(value);
	else await check();
}
