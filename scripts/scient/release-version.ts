#!/usr/bin/env bun
/**
 * Checks that `scient.json`'s version may be released now. As in Scient
 * Desktop's release, a version is used up when its release is published, not
 * when a build of it is drafted or fails: the version must come right after the
 * latest published release, and no tag may carry it yet (publishing a draft
 * creates its tag). An unpublished draft holds no tag, so the next release run
 * of the same version replaces it.
 *
 *   GITHUB_REPOSITORY=ScientFactory/scient-agent bun scripts/scient/release-version.ts
 *
 * Prints the version and writes `version=<version>` to `$GITHUB_OUTPUT` when it
 * is set; exits 1 with the reason when the version may not be released.
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

export interface ReleaseState {
	/** The latest published release's tag (`v0.1.8`), or null before the first one. */
	latestPublished: string | null;
	/** Whether a tag `v<version>` exists already. */
	tagExists: boolean;
}

/** Why `version` may not be released in `state`, or undefined when it may. */
export function releaseRefusal(version: string, state: ReleaseState): string | undefined {
	if (!VERSION.test(version)) return `scient.json's version ${version} is not x.y.z.`;
	const latest = state.latestPublished?.replace(/^v/, "") ?? null;
	const next = latest === null ? null : nextVersions(latest);
	if (state.tagExists) {
		// Only publishing tags a version now, so a tag on the next version with no published
		// release was made another way (a pushed tag, as releases were once made).
		if (next?.includes(version)) {
			return `v${version} is tagged, but no release of it is published. A release run never tags; delete that tag, then run the release again.`;
		}
		return `v${version} is tagged already, and a tagged version is never released again. Set scient.json to the version after the latest published release.`;
	}
	if (next === null || next.includes(version)) return undefined;
	return `The latest published release is v${latest}, so the next release is ${next.join(", ")} (patch, minor or major), not ${version}.`;
}

/** `gh` output, or null when GitHub answers 404; any other failure throws, so the check fails closed. */
async function ghOrNotFound(args: string[]): Promise<string | null> {
	const result = await $`gh ${args}`.nothrow().quiet();
	if (result.exitCode === 0) return result.text().trim();
	const stderr = result.stderr.toString();
	if (stderr.includes("HTTP 404")) return null;
	throw new Error(`gh ${args.join(" ")} failed: ${stderr.trim()}`);
}

if (import.meta.main) {
	const repo = process.env.GITHUB_REPOSITORY;
	if (!repo) {
		console.error("GITHUB_REPOSITORY is not set.");
		process.exit(2);
	}
	const repoRoot = path.resolve(import.meta.dir, "..", "..");
	const { version } = (await Bun.file(path.join(repoRoot, "scient.json")).json()) as { version: string };
	const latestPublished = await ghOrNotFound(["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"]);
	const tagExists = (await ghOrNotFound(["api", `repos/${repo}/git/ref/tags/v${version}`, "--jq", ".ref"])) !== null;
	const refusal = releaseRefusal(version, { latestPublished, tagExists });
	if (refusal) {
		console.log(`::error::${refusal}`);
		process.exitCode = 1;
	} else {
		console.log(`Releasing ${version}; the latest published release is ${latestPublished ?? "none"}.`);
		const output = process.env.GITHUB_OUTPUT;
		if (output) appendFileSync(output, `version=${version}\n`);
	}
}
