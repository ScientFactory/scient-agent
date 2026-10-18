import { describe, expect, it } from "bun:test";
import { mnemopiEmbedLaunch } from "@oh-my-pi/pi-coding-agent/mnemopi/embed-client";
import { workerTag } from "@oh-my-pi/pi-coding-agent/scient/worker-tag";
import { onnxLaunch } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { PRODUCT_VERSION } from "@oh-my-pi/pi-utils/scient/product";

describe("shared worker tags", () => {
	it("lead with Scient Agent's release", () => {
		expect(workerTag(VERSION)).toBe(`${PRODUCT_VERSION}|${VERSION}`);
	});

	it("tag the embedding server and the tiny model worker with it", () => {
		const embed = mnemopiEmbedLaunch("bge-small-en-v1.5");
		expect(embed.tag).toBe(workerTag(VERSION));
		const tiny = onnxLaunch("lfm2.5-230m", {});
		expect(tiny.tag.startsWith(`${PRODUCT_VERSION}|`)).toBe(true);
	});
});
