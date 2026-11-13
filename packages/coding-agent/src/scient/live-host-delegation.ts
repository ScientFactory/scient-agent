/**
 * Live voice requests handed to the RPC host.
 *
 * A live session turns each spoken request into a turn of its own session. A host that owns its
 * turns (Scient Desktop) never asked for those turns, so it can't show, stop or queue them like
 * the user's. With `hostDelegation`, the session hands each request to the host instead, the host
 * sends it as the user's message, and the live session reads that turn's answer as before.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "../session/agent-session-events";

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

/** The text of a user message, whichever form its content takes. */
function userText(message: AgentMessage): string | undefined {
	if (message.role !== "user") return undefined;
	const { content } = message;
	if (typeof content === "string") return content;
	return content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

/**
 * Whether a prompt is the host's message for `request`: the request itself, or the request
 * followed by what the host appends on later lines (attachment paths). A different message that
 * merely contains the request does not count.
 */
function carries(text: string | undefined, request: string): boolean {
	const prompt = text?.trim();
	return prompt === request || prompt?.startsWith(`${request}\n`) === true;
}

/**
 * Holds back a delegated request's progress and answer until the turn that carries it starts.
 * The host may queue the request behind a turn already running; that turn's answer must not be
 * spoken as this request's.
 */
export class HostTurnGate {
	#awaiting: string | undefined;

	/** The host was asked to send `request`; events before its turn belong to other turns. */
	expect(request: string): void {
		this.#awaiting = request;
	}

	/** Whether `event` comes before the awaited request's turn and must be ignored. */
	blocks(event: AgentSessionEvent): boolean {
		if (this.#awaiting === undefined) return false;
		if (event.type === "message_start" && carries(userText(event.message), this.#awaiting)) {
			this.#awaiting = undefined;
		}
		return true;
	}
}
