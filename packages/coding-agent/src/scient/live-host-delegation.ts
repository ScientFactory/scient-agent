/**
 * Live voice requests handed to the RPC host.
 *
 * A live session turns each spoken request into a turn of its own session. A host that owns its
 * turns (Scient Desktop) never asked for those turns, so it can't show, stop or queue them like
 * the user's. With `hostDelegation`, the session hands each request to the host instead, the host
 * sends it as the user's message, and the live session reads that turn's answer as before.
 */

/** A spoken request for the host to send as the user's message. */
export interface RpcLiveDelegationFrame {
	type: "live_delegation";
	text: string;
}

/** Hands one delegated request to whoever runs the session's turns. */
export type LiveDelegate = (request: string) => void;

/** A delegate that sends each request to the RPC host as a `live_delegation` frame. */
export function hostLiveDelegate(output: (frame: RpcLiveDelegationFrame) => void): LiveDelegate {
	return text => output({ type: "live_delegation", text });
}
