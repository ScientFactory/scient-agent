#!/usr/bin/env bun
/**
 * Writes the source revision into `packages/coding-agent/src/scient/build-id.ts`,
 * so the executable built next reports it in `--runtime-info`. Scient's workflow
 * runs it right after checkout, before any build step changes a tracked file,
 * so a clean checkout is not reported dirty.
 *
 *   bun scripts/scient/stamp-build-id.ts
 */
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.resolve(import.meta.dir, "..", "..");
const file = path.join(repoRoot, "packages", "coding-agent", "src", "scient", "build-id.ts");
const DECLARATION = /export const BUILD_ID: string = "[^"]*";/;

const revision = (await $`git -C ${repoRoot} rev-parse --short=12 HEAD`.quiet().text()).trim();
const dirty = (await $`git -C ${repoRoot} status --porcelain`.quiet().text()).trim().length > 0;
const buildId = dirty ? `${revision}-dirty` : revision;

const source = await Bun.file(file).text();
if (!DECLARATION.test(source)) throw new Error(`${file} no longer declares BUILD_ID`);
await Bun.write(file, source.replace(DECLARATION, `export const BUILD_ID: string = ${JSON.stringify(buildId)};`));
console.log(`Build id: ${buildId}`);
