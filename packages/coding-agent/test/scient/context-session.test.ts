import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

it("keeps external tool names out of the initial SDK prompt and eval description while retaining device calls", async () => {
	using temp = TempDir.createSync("scient-context-session-");
	const authStorage = await AuthStorage.create(":memory:");
	const calls: string[] = [];
	const parameters = type({ query: "string" });
	const { session } = await createAgentSession({
		cwd: temp.path(),
		agentDir: temp.join("agent"),
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, temp.join("models.yml")),
		model: getBundledModel("openai", "gpt-4o-mini"),
		settings: Settings.isolated(),
		sessionManager: SessionManager.inMemory(temp.path()),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		extensions: [
			pi => {
				for (let index = 0; index < 703; index++)
					pi.registerTool({
						name: `service__record_${index}`,
						label: "service",
						description: "Find a record in the connected service.",
						parameters,
						mcpServerName: "service",
						// Read through the tool proxy, like the ChatGPT apps and Scient's bridge set it.
						...{ mcpServerDescription: "Synthetic records." },
						mcpToolName: `record_${index}`,
						async execute(_id, args) {
							calls.push(args.query);
							return { content: [{ type: "text", text: args.query }] };
						},
					});
			},
		],
	});
	try {
		const prompt = session.systemPrompt.join("\n");
		expect(prompt).toContain("xd://services/service");
		expect(prompt).not.toContain("service__record_0");
		expect(prompt).not.toContain("MCP Tool Routes");
		expect(session.getToolByName("eval")?.description).not.toContain("service__record_0");
		const read = session.getToolByName("read")!;
		const listing = await read.execute("discover", { path: "xd://services/service" });
		expect(listing.content).toContainEqual(
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining("xd://service__record_0"),
			}),
		);
		const rest = await read.execute("discover-rest", { path: "xd://services/service:601" });
		expect(rest.content).toContainEqual(
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining("xd://service__record_702"),
			}),
		);
		const write = session.getToolByName("write")!;
		const result = await write.execute("call", { path: "xd://service__record_702", content: '{"query":"lab"}' });
		expect(result.isError).not.toBe(true);
		expect(calls).toEqual(["lab"]);
	} finally {
		await session.dispose();
		authStorage.close();
	}
});
