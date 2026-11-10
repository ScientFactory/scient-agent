import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { EphemeralTurnOptions } from "../../src/session/agent-session-types";
import { RpcNextMessagePredictor, SKIP_REPLY } from "../../src/scient/next-message";

interface FakeTurn {
	options: EphemeralTurnOptions;
	resolve(reply: string): void;
}

function fakeSession() {
	const turns: FakeTurn[] = [];
	const usage: unknown[] = [];
	const session = {
		model: { provider: "test", id: "model" },
		messages: [{ role: "assistant", content: [] }] as unknown as AgentMessage[],
		isStreaming: false,
		isCompacting: false,
		sessionManager: {
			getSessionId: () => "session",
			getLeafId: () => "leaf",
			appendModelUsage: (entry: unknown) => {
				usage.push(entry);
				return "usage";
			},
		},
		ephemeralMaxTokensPreservesRequest: () => true,
		runEphemeralTurn: (options: EphemeralTurnOptions) => {
			const { promise, resolve, reject } = Promise.withResolvers<{ replyText: string; assistantMessage: unknown }>();
			options.signal?.addEventListener("abort", () => reject(options.signal?.reason));
			turns.push({
				options,
				resolve: reply => resolve({ replyText: reply, assistantMessage: { api: "test", usage: {} } }),
			});
			return promise;
		},
	};
	return { session, turns, usage };
}

function predictor(session: ReturnType<typeof fakeSession>["session"]) {
	return new RpcNextMessagePredictor(session as unknown as ConstructorParameters<typeof RpcNextMessagePredictor>[0]);
}

describe("predict_next_message", () => {
	it("returns Oh My Pi's parsed prediction and records its usage", async () => {
		const { session, turns, usage } = fakeSession();
		const pending = predictor(session).predict();
		expect(turns[0].options.promptText).toContain(SKIP_REPLY);
		expect(turns[0].options.minimizeEffort).toBe(true);
		turns[0].resolve('"Run it on the full dataset"');
		expect(await pending).toBe("Run it on the full dataset");
		expect(usage).toHaveLength(1);
	});

	it("returns null for a skip, a running turn, a newer request and a conversation that moved on", async () => {
		const { session, turns } = fakeSession();
		const p = predictor(session);

		const skipped = p.predict();
		turns[0].resolve(SKIP_REPLY);
		expect(await skipped).toBeNull();

		const replaced = p.predict();
		const newer = p.predict();
		expect(await replaced).toBeNull();
		turns[2].resolve("Next");
		expect(await newer).toBe("Next");

		const movedOn = p.predict();
		session.messages = [...session.messages, { role: "user", content: [] } as unknown as AgentMessage];
		turns[3].resolve("Too late");
		expect(await movedOn).toBeNull();

		session.isStreaming = true;
		expect(await p.predict()).toBeNull();
		expect(turns).toHaveLength(4);
	});
});
