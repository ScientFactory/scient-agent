import { APP_NAME, PRODUCT_VERSION, UPSTREAM } from "@oh-my-pi/pi-utils/dirs";
import type { RpcReadyFrame } from "../modes/rpc/rpc-types";

/**
 * What a host needs to recognise this executable and decide whether it can
 * drive it, printed as one JSON line by `--runtime-info`. The RPC protocol
 * itself carries no product identity, so a host reads this before it starts
 * `--mode rpc`.
 */
export interface RuntimeInfo {
	/** Product name; a host refuses an executable that reports another one. */
	product: string;
	/** Scient Agent release version. */
	version: string;
	/** The Oh My Pi release this build derives from; RPC and session compatibility follow it. */
	upstream: { name: string; version: string; commit: string };
	rpcProtocolVersions: RpcReadyFrame["supportedProtocolVersions"];
	/** Source revision of this build, or "source" when run from a checkout. */
	buildId: string;
}

export function formatRuntimeInfo(): string {
	const info: RuntimeInfo = {
		product: APP_NAME,
		version: PRODUCT_VERSION,
		upstream: UPSTREAM,
		rpcProtocolVersions: [1, 2],
		buildId: process.env.SCIENT_AGENT_BUILD_ID || "source",
	};
	return `${JSON.stringify(info)}\n`;
}
