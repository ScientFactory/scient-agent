#!/usr/bin/env bun
/** Credential-free compiled-runtime proof. Uses loopback stubs, preserves fixture evidence, and never touches real sessions. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { strict as assert } from "node:assert";
import { RpcClient } from "../../packages/coding-agent/src/modes/rpc/rpc-client";

const candidate = process.argv[2];
const previous = process.argv[3];
if (!candidate || !previous || !path.isAbsolute(candidate) || !path.isAbsolute(previous))
	throw new Error("Usage: bun scripts/scient/capability-check.ts <absolute-candidate> <absolute-previous>");
// Never inherit credentials or other agents' discovery variables in this probe.
for (const name of Object.keys(process.env))
	if (!["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "COMSPEC"].includes(name)) delete process.env[name];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "scient-agent-capability-"));
const home = path.join(root, "home");
const state = path.join(root, "state");
const cwd = path.join(root, "workspace");
for (const dir of [home, state, cwd, path.join(state, "agent", "skills", "alignment-proof")])
	fs.mkdirSync(dir, { recursive: true });
const sentinel = `SKILL_${path.basename(root)}`;
fs.writeFileSync(
	path.join(state, "agent", "skills", "alignment-proof", "SKILL.md"),
	`---\nname: alignment-proof\ndescription: Native alignment qualification only.\n---\n\n${sentinel}\n`,
);
let phase = "old";
const requests: Array<{ phase: string; child: boolean; tools: string[]; body: string }> = [];
let childStarts = 0;
const childGate = Promise.withResolvers<void>();
const bothChildren = childGate.promise;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	idleTimeout: 120,
	async fetch(request) {
		const raw = await request.text();
		const body = JSON.parse(raw) as {
			messages?: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
			tools?: Array<{ function?: { name?: string } }>;
		};
		const names = body.tools?.flatMap(tool => (tool.function?.name ? [tool.function.name] : [])) ?? [];
		const child = names.includes("yield");
		requests.push({ phase, child, tools: names, body: raw });
		const results = body.messages?.filter(message => message.role === "tool") ?? [];
		const text = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));
		const output = results.map(message => text(message.content)).join("\n");
		let call: { name: string; args: unknown } | undefined;
		let answer = "";
		if (phase !== "native") answer = phase === "old" ? "OLD_SESSION_PROOF" : "UPGRADED_SESSION_PROOF";
		else if (child) {
			if (results.length === 0) {
				childStarts++;
				if (childStarts === 2) childGate.resolve();
				await bothChildren;
				call = { name: "bash", args: { command: "printf CHILD_COMPUTED_42", timeout: 5 } };
			} else if (!results.some(message => message.tool_call_id?.startsWith("yield-"))) {
				assert.ok(output.includes("CHILD_COMPUTED_42"), "actual child shell result must reach its model");
				call = { name: "yield", args: { data: { proof: "CHILD_COMPUTED_42" } } };
			} else answer = "CHILD_DONE";
		} else if (!results.some(message => message.tool_call_id?.startsWith("eval-")))
			call = {
				name: "eval",
				args: { language: "js", code: "console.log(JSON.stringify({proof:'EVAL_JS_OK',value:6*7}))", timeout: 5 },
			};
		else if (!results.some(message => message.tool_call_id?.startsWith("read-"))) {
			assert.match(output, /EVAL_JS_OK/);
			assert.match(output, /42/);
			call = { name: "read", args: { path: "skill://alignment-proof" } };
		} else if (!results.some(message => message.tool_call_id?.startsWith("bash-"))) {
			assert.ok(output.includes(sentinel), "actual skill text must arrive at model");
			call = {
				name: "bash",
				args: { command: "printf ARTIFACT_42 > alignment-artifact.txt; cat alignment-artifact.txt", timeout: 5 },
			};
		} else if (!results.some(message => message.tool_call_id?.startsWith("task-"))) {
			assert.match(output, /ARTIFACT_42/);
			call = {
				name: "task",
				args: {
					i: "two-child-proof",
					context: "Bounded alignment qualification",
					tasks: [
						{ agent: "task", task: "ALPHA: run printf CHILD_COMPUTED_42 and yield that exact result." },
						{ agent: "task", task: "BETA: run printf CHILD_COMPUTED_42 and yield that exact result." },
					],
				},
			};
		} else answer = "NATIVE_CAPABILITIES_OK";
		if (call) assert.ok(names.includes(call.name), `required tool ${call.name} missing`);
		const chunk = (delta: unknown, finish: string | null) =>
			`data: ${JSON.stringify({ id: "capability-proof", object: "chat.completion.chunk", created: 1, model: "proof", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		const payload = call
			? chunk(
					{
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: `${call.name}-${requests.length}`,
								type: "function",
								function: { name: call.name, arguments: JSON.stringify(call.args) },
							},
						],
					},
					null,
				) + chunk({}, "tool_calls")
			: chunk({ role: "assistant", content: answer }, null) + chunk({}, "stop");
		return new Response(payload + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	},
});
fs.writeFileSync(
	path.join(state, "agent", "models.yml"),
	`providers:\n  alignment-proof:\n    api: openai-completions\n    baseUrl: http://127.0.0.1:${server.port}/v1\n    auth: none\n    models:\n      - id: proof\n        name: Proof\n        contextWindow: 16384\n        maxTokens: 2048\n        input: [text]\n`,
);
fs.writeFileSync(path.join(state, "agent", "config.yml"), "retry:\n  enabled: false\ndisabledProviders:\n  - ollama\n");
const env = {
	HOME: home,
	USERPROFILE: home,
	PATH: process.env.PATH ?? "",
	SCIENT_AGENT_ROOT: state,
	HTTPS_PROXY: "http://127.0.0.1:9",
	HTTP_PROXY: "http://127.0.0.1:9",
	NO_PROXY: "127.0.0.1,localhost,::1",
};
let active: RpcClient | undefined;
const client = (binary: string, extra: string[] = []) =>
	new RpcClient({
		command: [binary],
		cwd,
		env,
		provider: "alignment-proof",
		model: "proof",
		sessionDir: path.join(state, "sessions"),
		args: ["--no-extensions", ...extra],
	});
const guard = setTimeout(() => {
	void active?.stop();
	server.stop(true);
	throw new Error("Bounded probe exceeded 150 seconds");
}, 150000);
try {
	active = client(previous);
	await active.start();
	await active.promptAndWait("Create the old persisted session", undefined, 30000);
	const oldState = await active.getState();
	assert.ok(oldState.sessionFile);
	await active.stop();
	fs.cpSync(state, path.join(root, "pre-upgrade-state"), { recursive: true });
	phase = "upgrade";
	active = client(candidate, ["--session", oldState.sessionFile]);
	await active.start();
	assert.ok(JSON.stringify(await active.getMessages()).includes("OLD_SESSION_PROOF"));
	await active.promptAndWait("Continue the restored session", undefined, 30000);
	assert.ok(JSON.stringify(await active.getMessages()).includes("UPGRADED_SESSION_PROOF"));
	await active.stop();
	// Verify only a clean pre-upgrade snapshot rollback, never claim reverse-schema migration.
	phase = "rollback";
	active = new RpcClient({
		command: [previous],
		cwd,
		env: { ...env, SCIENT_AGENT_ROOT: path.join(root, "pre-upgrade-state") },
		provider: "alignment-proof",
		model: "proof",
		args: [
			"--no-extensions",
			"--session",
			oldState.sessionFile!.replace(state, path.join(root, "pre-upgrade-state")),
		],
	});
	await active.start();
	assert.ok(JSON.stringify(await active.getMessages()).includes("OLD_SESSION_PROOF"));
	await active.stop();
	phase = "native";
	active = client(candidate);
	const children: Array<{ id: string; status: string }> = [];
	active.onSubagentLifecycle(receipt => children.push({ id: receipt.id, status: receipt.status }));
	await active.start();
	await active.setSubagentSubscription("progress");
	await active.promptAndWait("Exercise eval, the native Skill, an artifact, and two children.", undefined, 90000);
	await active.waitForSettled(90000);
	fs.writeFileSync(
		path.join(root, "receipts.json"),
		JSON.stringify({ requests, children, messages: await active.getMessages() }, null, 2),
	);
	assert.equal(childStarts, 2);
	assert.equal(new Set(children.filter(row => row.status === "completed").map(row => row.id)).size, 2);
	assert.equal(fs.readFileSync(path.join(cwd, "alignment-artifact.txt"), "utf8"), "ARTIFACT_42");
	assert.ok(requests.some(row => row.phase === "native" && row.body.includes(sentinel)));
	assert.ok(requests.filter(row => row.child).every(row => row.tools.includes("bash")));
	console.log(
		JSON.stringify({
			passed: [
				"old-session-resume-and-continue",
				"pre-upgrade-snapshot-rollback",
				"native-skill-text",
				"native-js-eval-computed-42",
				"shell-artifact",
				"two-overlapping-completed-children",
			],
			childStarts,
			completedChildren: children.filter(row => row.status === "completed"),
			requests: requests.length,
			fixtureRoot: root,
		}),
	);
} finally {
	clearTimeout(guard);
	await active?.stop();
	server.stop(true);
}
