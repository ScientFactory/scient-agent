import { expect, it } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { type } from "@oh-my-pi/omptype";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

it("keeps external tool names out of the initial SDK prompt and eval description and mount notices", async () => {
	using temp = TempDir.createSync("@scient-context-session-");
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("openai", "test-key");
	const calls: string[] = [];
	const lastCommand = "service__record_702_e5b2bd51";
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
						name: index === 702 ? lastCommand : `service__record_${index}`,
						label: "service",
						loadMode: "discoverable",
						defaultInactive: index === 702,
						description: "Find a record in the connected service.",
						parameters,
						mcpServerName: "service",
						// Read through the tool proxy, like the ChatGPT apps and Scient's bridge set it.
						...{ mcpServerDescription: "Synthetic records." },
						mcpToolName: index === 702 ? "record.702" : `record_${index}`,
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
		expect(prompt.match(/help:\/\/services\/service/g)).toHaveLength(1);
		expect(prompt).toContain("702 tools");
		expect(prompt).not.toContain("service__record_0");
		expect(session.getToolByName("eval")?.description).not.toContain("service__record_0");
		expect(session.getToolForEvalBridge("service__record_0")?.name).toBe("service__record_0");
		const enabled = session.getEnabledToolNames();
		const mounted = session.getMountedToolCommandNames();
		// Late discovery before the first request must update the service count without a second listing.
		await session.setActiveToolPresentation([...enabled, lastCommand], [...mounted, lastCommand]);
		expect(session.systemPrompt.join("\n")).toContain("703 tools");
		const read = session.getToolByName("read")!;
		const first = await read.execute("first", { path: "help://services/service:1-12:raw" });
		expect(JSON.stringify(first.content)).toContain("service__record_0");
		expect(JSON.stringify(first.content)).not.toContain(lastCommand);
		const rest = await read.execute("tail", { path: "help://services/service:601-:raw" });
		expect(rest.content).toContainEqual(
			expect.objectContaining({ text: expect.stringContaining('"record.702" → `' + lastCommand + "`") }),
		);
		const write = session.getToolByName("write")!;
		await expect(write.execute("read-only", { path: "help://services/service", content: "{}" })).rejects.toThrow(
			/read.only|writ/i,
		);
		const bash = session.getToolByName("bash")!;
		const help = await bash.execute("usage", { command: lastCommand + " --help" });
		expect(JSON.stringify(help.content)).toContain("--query");
		expect(calls).toEqual([]);
		const result = await bash.execute("call", { command: lastCommand + ` -j '{"query":"lab"}'` });
		expect(result.isError).not.toBe(true);
		expect(calls).toEqual(["lab"]);
		session.agent.streamFn = createMockModel({ handler: { content: ["ok"] } }).stream;
		await session.prompt("hello");
		const notices = session.agent.state.messages.filter(
			m => m.role === "custom" && m.customType === "tool-command-mount-notice",
		);
		expect(JSON.stringify(notices)).not.toContain(lastCommand);
		const all = session.getEnabledToolNames();
		const mounts = session.getMountedToolCommandNames();
		await session.setActiveToolPresentation(
			all.filter(name => name !== "read"),
			mounts,
			true,
		);
		const noReader = session.systemPrompt.join("\n");
		expect(noReader).not.toContain("help://services/service");
		expect(noReader).toContain(lastCommand);
		expect(noReader).toContain("MCP Tool Commands");
		await session.setActiveToolPresentation(
			all.filter(name => name !== "bash"),
			mounts,
			true,
		);
		expect(session.getActiveToolNames()).toContain(lastCommand);
		expect(session.getMountedToolCommandNames()).not.toContain(lastCommand);
		expect(session.systemPrompt.join("\n")).not.toContain("help://services/service");
		await expect(read.execute("stale", { path: "help://services/service" })).rejects.toThrow("No mounted tools");
	} finally {
		await session.dispose();
		authStorage.close();
	}
});
