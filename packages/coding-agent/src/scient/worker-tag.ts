import { PRODUCT_VERSION } from "@oh-my-pi/pi-utils/scient/product";

/**
 * The launch tag of a shared worker (the tiny model worker, the embedding
 * server), which a later process reuses while the tags match. Oh My Pi tags
 * them with its package version, which two Scient Agent releases on one Oh My
 * Pi release share, so Scient Agent's release leads the tag: a new release
 * never talks to a worker an earlier one left running.
 */
export function workerTag(upstreamTag: string): string {
	return `${PRODUCT_VERSION}|${upstreamTag}`;
}
