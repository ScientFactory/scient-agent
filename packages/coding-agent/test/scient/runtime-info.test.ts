import { describe, expect, it } from "bun:test";
import { BUILD_ID } from "@oh-my-pi/pi-coding-agent/scient/build-id";
import { formatRuntimeInfo, type RuntimeInfo } from "@oh-my-pi/pi-coding-agent/scient/runtime-info";
import { PRODUCT_VERSION, UPSTREAM } from "@oh-my-pi/pi-utils/scient/product";

describe("--runtime-info", () => {
	it("prints one JSON line a host can check before it starts RPC mode", () => {
		const output = formatRuntimeInfo();
		expect(output.endsWith("\n")).toBe(true);
		expect(output.trimEnd().includes("\n")).toBe(false);
		const info = JSON.parse(output) as RuntimeInfo;
		expect(info).toEqual({
			product: "scient-agent",
			version: PRODUCT_VERSION,
			upstream: UPSTREAM,
			rpcProtocolVersions: [1, 2],
			buildId: BUILD_ID,
		});
	});
});
