import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "../../src/config/settings";
import { LiveSessionController, type LiveSessionControllerOptions } from "../../src/live/controller";
import type { LiveServerEvent } from "../../src/live/protocol";
import * as liveTransport from "../../src/live/transport";
import type { LiveTransportOptions } from "../../src/live/transport";
import { RpcLiveBridge, type RpcLiveSession } from "../../src/modes/rpc/rpc-live";
import type { RpcLiveFrame } from "../../src/modes/rpc/rpc-types";
import type { AgentSession } from "../../src/session/agent-session";

afterEach(() => {
	vi.restoreAllMocks();
});

const delegationCreated = (id: string, text: string): LiveServerEvent => ({
	type: "delegation.created",
	item: { type: "delegation", target: "client", id, content: [{ type: "input_text", text }] },
});

/** A controller on a stand-in transport, returning the transport's event callback. */
async function startController(options: Partial<LiveSessionControllerOptions>) {
	let onEvent: ((event: LiveServerEvent) => void) | undefined;
	let onSessionEvent: ((event: unknown) => void) | undefined;
	const sentToModel: unknown[] = [];
	const transportSpy = vi.spyOn(liveTransport, "CodexLiveTransport") as unknown as {
		mockImplementation(implementation: (options: LiveTransportOptions) => object): void;
	};
	transportSpy.mockImplementation(function (transportOptions: LiveTransportOptions) {
		onEvent = transportOptions.callbacks.onEvent;
		return {
			connect: async () => {},
			setMuted: async () => {},
			send: async (message: unknown) => {
				sentToModel.push(message);
			},
			close: async () => {},
			sdpAnswer: "v=0 answer",
		};
	});
	const sentToSession: string[] = [];
	const session = {
		modelRegistry: { authStorage: {} },
		sessionId: "s1",
		subscribe: (listener: (event: unknown) => void) => {
			onSessionEvent = listener;
			return () => {};
		},
		sendCustomMessage: async (message: { content: string }) => {
			sentToSession.push(message.content);
		},
	} as unknown as LiveSessionControllerOptions["session"];
	const controller = new LiveSessionController({
		session,
		extractAssistantText: (message: { content: Array<{ type: string; text?: string }> }) =>
			message.content.map(part => part.text ?? "").join(""),
		sdpOffer: "v=0 offer",
		callbacks: { onPhase: () => {}, onLevels: () => {}, onTranscript: () => {}, onTerminal: () => {} },
		...options,
	});
	await controller.start();
	return {
		controller,
		emit: (event: LiveServerEvent) => onEvent!(event),
		emitSession: (event: unknown) => onSessionEvent!(event),
		sentToModel,
		sentToSession,
	};
}

describe("live host delegation", () => {
	it("hands a spoken request to the delegate instead of starting a turn", async () => {
		const delegated: string[] = [];
		const { controller, emit, sentToSession } = await startController({
			delegate: request => delegated.push(request),
		});
		emit(delegationCreated("d1", "list the files"));
		expect(delegated).toEqual(["list the files"]);
		expect(sentToSession).toEqual([]);
		expect(controller.phase).toBe("working");
		await controller.stop();
	});

	it("speaks only the answer of the turn that carries a queued request", async () => {
		const { controller, emit, emitSession, sentToModel } = await startController({ delegate: () => {} });
		const answer = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
		emit(delegationCreated("d1", "list the files"));
		// A turn that was already running ends first: its answer is not this request's.
		emitSession({ type: "agent_end", messages: [answer("earlier answer")] });
		// A queued message that merely contains the request is another turn too.
		emitSession({ type: "message_start", message: { role: "user", content: "list the files and their sizes" } });
		emitSession({ type: "agent_end", messages: [answer("sizes answer")] });
		emitSession({
			type: "message_start",
			message: { role: "user", content: "list the files\n\nAttached files:\n/tmp/a.txt" },
		});
		emitSession({ type: "agent_end", messages: [answer("a.txt and b.txt")] });
		await Bun.sleep(0);
		const spoken = JSON.stringify(sentToModel);
		expect(spoken).not.toContain("earlier answer");
		expect(spoken).not.toContain("sizes answer");
		expect(spoken).toContain("a.txt and b.txt");
		await controller.stop();
	});

	it("speaks the host's report of a turn it ran elsewhere, and only during a delegation", async () => {
		const { controller, emit, sentToModel } = await startController({ delegate: () => {} });
		controller.reportHostWork("nothing is delegated yet", true);
		expect(sentToModel).toEqual([]);
		emit(delegationCreated("d1", "run the analysis"));
		controller.reportHostWork("Loading the cohort", false);
		controller.reportHostWork("The hazard ratio is 1.4", true);
		controller.reportHostWork("a late report", false);
		await Bun.sleep(0);
		const spoken = JSON.stringify(sentToModel);
		expect(spoken).toContain('"channel":"commentary"');
		expect(spoken).toContain("Loading the cohort");
		expect(spoken).toContain("The hazard ratio is 1.4");
		expect(spoken).not.toContain("a late report");
		expect(controller.phase).not.toBe("working");
		await controller.stop();
	});

	it("starts the turn itself when no delegate is set", async () => {
		const { controller, emit, sentToSession } = await startController({});
		emit(delegationCreated("d1", "list the files"));
		expect(sentToSession).toEqual(["list the files"]);
		await controller.stop();
	});

	it("gives the controller a delegate that sends live_delegation frames only when the host asks", async () => {
		const frames: RpcLiveFrame[] = [];
		const created: LiveSessionControllerOptions[] = [];
		const agentSession = { settings: Settings.isolated({ "live.voice": "sol" }) } as unknown as AgentSession;
		const bridge = new RpcLiveBridge(
			agentSession,
			frame => frames.push(frame),
			options => {
				created.push(options);
				return {
					muted: false,
					sdpAnswer: "v=0 answer",
					start: async () => {},
					stop: async () => {},
					toggleMute: () => {},
				} satisfies RpcLiveSession;
			},
		);
		await bridge.start({ sdpOffer: "v=0 offer", hostDelegation: true });
		created[0]!.delegate!("open the PR list");
		expect(frames).toContainEqual({ type: "live_delegation", text: "open the PR list" });
		await bridge.stop();
		await bridge.start({ sdpOffer: "v=0 offer" });
		expect(created[1]!.delegate).toBeUndefined();
		await bridge.stop();
	});
});
