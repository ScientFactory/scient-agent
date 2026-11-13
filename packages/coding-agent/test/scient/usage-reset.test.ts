import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { RpcPromptResults } from "../../src/modes/rpc/rpc-prompt-results";
import type { RpcPromptResultFrame } from "../../src/modes/rpc/rpc-types";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

const MOCK_API_SOURCE = "scient-usage-reset-test";

async function flushFrames(): Promise<void> {
	for (let hop = 0; hop < 2; hop++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

describe("prompt_result reset time of a usage limit", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@scient-usage-reset-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		unregisterCustomApis(MOCK_API_SOURCE);
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	/** Runs one RPC prompt whose every request fails with `failure`, and returns its prompt_result. */
	async function promptResultFor(failure: string): Promise<RpcPromptResultFrame> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled Anthropic test model");
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		const mock = createMockModel({ handler: () => ({ throw: failure }) });
		const agent = new Agent({
			getApiKey: requested => `${requested.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requested, context, options) => mock.stream(requested, context, options),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		const frames: RpcPromptResultFrame[] = [];
		const results = new RpcPromptResults(session, frame => frames.push(frame));
		session.subscribe(event => results.observe(event));
		const ticket = results.begin("req");
		await session.prompt("hit the usage limit");
		await session.waitForIdle();
		results.settle(ticket);
		await flushFrames();
		expect(frames).toHaveLength(1);
		return frames[0];
	}

	it("carries the reset the provider stated", async () => {
		const before = Date.now();
		const frame = await promptResultFor("429 Usage limit reached for 5 hour. retry-after-ms=3600000");
		const after = Date.now();

		expect(frame.status).toBe("error");
		expect(frame.error?.resetAt).toBeGreaterThanOrEqual(before + 3_600_000);
		expect(frame.error?.resetAt).toBeLessThanOrEqual(after + 3_600_000);
	});

	it("leaves the reset out when the provider gave no time", async () => {
		const frame = await promptResultFor("429 quota exceeded for this account");

		expect(frame.status).toBe("error");
		expect(frame.error).toBeDefined();
		expect(frame.error).not.toHaveProperty("resetAt");
	});
});
