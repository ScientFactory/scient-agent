#!/usr/bin/env bun
/**
 * Checks that a built Scient Agent keeps answering its host while it starts up
 * under the environment Scient Desktop launches it with: Claude and Codex
 * plugin sources on, and a Codex config present so plugin discovery runs. Work
 * that blocks the event loop after `ready` stalls every command, and Desktop
 * gives up on an agent that does not answer.
 *
 *   bun scripts/scient/responsiveness-check.ts <path-to-scient-agent>
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const executable = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
if (!executable || !fs.existsSync(executable)) {
	console.error("usage: bun scripts/scient/responsiveness-check.ts <path-to-scient-agent>");
	process.exit(2);
}

/** After `ready`, how long the agent is sampled and the slowest answer it may give. */
const SAMPLE_MS = 6_000;
const SAMPLE_EVERY_MS = 250;
const MAX_ANSWER_MS = 2_000;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scient-agent-responsiveness-"));
let failure: string | undefined;
try {
	const home = path.join(scratch, "home");
	const agentDir = path.join(home, "scient-agent", "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentDir, "config.yml"),
		"disabledProviders:\n  - ollama\n  - llama.cpp\n  - lm-studio\n",
	);
	fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
	fs.writeFileSync(path.join(home, ".codex", "config.toml"), "[features]\nplugins = true\n");
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		LANG: process.env.LANG ?? "en_US.UTF-8",
		TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
		...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
		HOME: home,
		USERPROFILE: home,
		APPDATA: path.join(home, "AppData", "Roaming"),
		LOCALAPPDATA: path.join(home, "AppData", "Local"),
		SCIENT_AGENT_ROOT: path.join(home, "scient-agent"),
		// As Scient Desktop sets them for every Scient Agent it starts.
		SCIENT_AGENT_ENABLE_SOURCES: "claude-plugins,codex-plugins",
		SCIENT_AGENT_HOST_PAGES: "1",
	};
	const child = Bun.spawn(
		[
			executable,
			"--mode",
			"rpc-ui",
			"--approval-mode",
			"yolo",
			"--no-session",
			"--no-tools",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
		],
		{ cwd: home, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	const ready = Promise.withResolvers<void>();
	const answered = new Map<string, () => void>();
	void (async () => {
		let buffer = "";
		const decoder = new TextDecoder();
		for await (const chunk of child.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				try {
					const frame = JSON.parse(line) as { type?: string; id?: string };
					if (frame.type === "ready") ready.resolve();
					if (frame.type === "response" && frame.id) answered.get(frame.id)?.();
				} catch {}
			}
		}
	})();
	const started = await Promise.race([ready.promise.then(() => true), Bun.sleep(30_000).then(() => false)]);
	if (!started) failure = "The agent did not report ready within 30 s.";
	let slowest = 0;
	for (let sample = 0; !failure && sample * SAMPLE_EVERY_MS < SAMPLE_MS; sample++) {
		const id = `state-${sample}`;
		const reply = Promise.withResolvers<void>();
		answered.set(id, reply.resolve);
		const sent = performance.now();
		child.stdin.write(`${JSON.stringify({ id, type: "get_state" })}\n`);
		const ok = await Promise.race([reply.promise.then(() => true), Bun.sleep(30_000).then(() => false)]);
		const took = performance.now() - sent;
		slowest = Math.max(slowest, took);
		if (!ok || took > MAX_ANSWER_MS)
			failure = `get_state ${sample + 1} took ${ok ? `${Math.round(took)} ms` : "over 30 s"} (at most ${MAX_ANSWER_MS} ms): something blocks the agent's event loop during startup.`;
		await Bun.sleep(SAMPLE_EVERY_MS);
	}
	child.stdin.end();
	await Promise.race([child.exited, Bun.sleep(15_000).then(() => child.kill("SIGKILL"))]);
	if (failure) console.error(`${failure}\nstderr: ${(await new Response(child.stderr).text()).slice(-600)}`);
	else console.log(`Responsiveness check passed: the slowest get_state took ${Math.round(slowest)} ms.`);
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(failure ? 1 : 0);
