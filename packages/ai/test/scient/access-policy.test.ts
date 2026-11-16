import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { complete } from "@oh-my-pi/pi-ai/stream";

const APP_RESTRICTED =
	"thinkingmachines/inkling-2-small:free is only available on agentic harnesses. Try plugging it into a coding agent or productivity app listed on https://openrouter.ai/apps";

describe("a model a provider serves only to its listed apps", () => {
	let server: ReturnType<typeof Bun.serve>;

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			fetch: () => Response.json({ error: { message: APP_RESTRICTED, code: 403 } }, { status: 403 }),
		});
	});

	afterAll(() => server.stop(true));

	it("is an account policy, which a host ranks before a failed sign-in", async () => {
		const model = getBundledModels("openrouter")[0];
		if (!model) throw new Error("Expected a bundled OpenRouter model");
		const failed = await complete(
			{ ...model, baseUrl: `http://localhost:${server.port}/v1` },
			{ systemPrompt: ["Test"], messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "openrouter-test-key" },
		);

		expect(failed.stopReason).toBe("error");
		expect(failed.errorStatus).toBe(403);
		expect(AIError.is(AIError.classifyMessage(failed), AIError.Flag.AccountPolicy)).toBe(true);
	});

	it("leaves another 403 a failed sign-in", () => {
		const id = AIError.classifyMessage({ provider: "openrouter", errorMessage: "403 Forbidden", errorStatus: 403 });
		expect(AIError.is(id, AIError.Flag.AuthFailed)).toBe(true);
		expect(AIError.is(id, AIError.Flag.AccountPolicy)).toBe(false);
	});
});
