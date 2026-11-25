#!/usr/bin/env bun
/**
 * Checks that a built Scient Agent starts in time and keeps answering its host
 * while it starts, under the environment Scient Desktop launches it with:
 * Claude and Codex plugin sources on, and a Codex config present so plugin
 * discovery runs. It launches twice, as Desktop's runtime qualification does
 * (no skills, tools or session) and as a Desktop conversation does (skills on,
 * so their discovery runs before `ready`). Desktop gives up on an agent that
 * is not ready in time or stops answering.
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

/** Scient Desktop 0.6.34 waits this long for `ready`. */
const MAX_READY_MS = 8_000;
/** After `ready`: this many `get_state` requests, this far apart, each answered within the limit. */
const SAMPLES = 24;
const SAMPLE_EVERY_MS = 250;
const MAX_ANSWER_MS = 2_000;
/** Variables Windows programs need that Desktop passes through. */
const PASSED_THROUGH = ["SystemRoot", "SystemDrive", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"];

const STUB_MODELS = `providers:
  scient-responsiveness:
    baseUrl: http://127.0.0.1:9/v1
    api: openai-completions
    auth: none
    models:
      - id: stub
        name: Responsiveness check stub
        input: [text]
        contextWindow: 8192
        maxTokens: 1024
`;

/** `promise`'s value, or `fallback` once `ms` passed; the timer never outlives the race. */
async function within<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<F>(resolve => (timer = setTimeout(() => resolve(fallback), ms))),
		]);
	} finally {
		clearTimeout(timer);
	}
}

interface Launch {
	readonly label: string;
	readonly args: (home: string) => string[];
}

const LAUNCHES: Launch[] = [
	{
		label: "Desktop's runtime qualification",
		args: () => ["--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-rules"],
	},
	{ label: "a Desktop conversation", args: home => ["--session-dir", path.join(home, "session")] },
];

async function check(launch: Launch): Promise<string | undefined> {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scient-agent-responsiveness-"));
	const home = path.join(scratch, "home");
	const agentDir = path.join(home, "scient-agent", "agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(path.join(home, "session"), { recursive: true });
	fs.writeFileSync(
		path.join(agentDir, "config.yml"),
		"disabledProviders:\n  - ollama\n  - llama.cpp\n  - lm-studio\n",
	);
	// A model, as Desktop's qualification supplies one: without it, startup waits on online model
	// discovery, which measures the network rather than the agent.
	fs.writeFileSync(path.join(agentDir, "models.yml"), STUB_MODELS);
	fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
	fs.writeFileSync(path.join(home, ".codex", "config.toml"), "[features]\nplugins = true\n");
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		LANG: process.env.LANG ?? "en_US.UTF-8",
		TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
		...Object.fromEntries(PASSED_THROUGH.flatMap(name => (process.env[name] ? [[name, process.env[name]!]] : []))),
		HOME: home,
		USERPROFILE: home,
		APPDATA: path.join(home, "AppData", "Roaming"),
		LOCALAPPDATA: path.join(home, "AppData", "Local"),
		SCIENT_AGENT_ROOT: path.join(home, "scient-agent"),
		// As Scient Desktop sets them for every Scient Agent it starts.
		SCIENT_AGENT_ENABLE_SOURCES: "claude-plugins,codex-plugins",
		SCIENT_AGENT_HOST_PAGES: "1",
		// Startup markers on stderr show that Codex plugin discovery ran.
		PI_DEBUG_STARTUP: "1",
	};
	const started = performance.now();
	const child = Bun.spawn([executable!, "--mode", "rpc-ui", "--approval-mode", "yolo", ...launch.args(home)], {
		cwd: home,
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	let stderr = "";
	const stderrDone = (async () => {
		for await (const chunk of child.stderr) stderr += new TextDecoder().decode(chunk);
	})();
	const ready = Promise.withResolvers<boolean>();
	const answers = new Map<string, (frame: Record<string, unknown>) => void>();
	const stdoutDone = (async () => {
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
					const frame = JSON.parse(line) as Record<string, unknown>;
					if (frame.type === "ready") ready.resolve(true);
					if (frame.type === "response" && typeof frame.id === "string") answers.get(frame.id)?.(frame);
				} catch {}
			}
		}
	})();
	let exited = false;
	void child.exited.then(() => {
		exited = true;
		ready.resolve(false);
		for (const answer of answers.values()) answer({});
	});
	const fail = (reason: string) => `${launch.label}: ${reason}\nstderr: ${stderr.slice(-800)}`;
	try {
		const isReady = await within(ready.promise, 30_000, false);
		const readyMs = performance.now() - started;
		if (!isReady) return fail(exited ? "the agent exited before it was ready." : "no ready within 30 s.");
		if (readyMs > MAX_READY_MS) return fail(`ready took ${Math.round(readyMs)} ms (at most ${MAX_READY_MS} ms).`);
		let slowest = 0;
		for (let sample = 0; sample < SAMPLES; sample++) {
			const id = `state-${sample}`;
			const reply = Promise.withResolvers<Record<string, unknown>>();
			answers.set(id, reply.resolve);
			const sent = performance.now();
			child.stdin.write(`${JSON.stringify({ id, type: "get_state" })}\n`);
			const frame = await within(reply.promise, 30_000, undefined);
			const took = performance.now() - sent;
			slowest = Math.max(slowest, took);
			if (exited) return fail("the agent exited while it was being sampled.");
			if (frame === undefined) return fail(`get_state ${sample + 1} had no answer within 30 s.`);
			if (frame.command !== "get_state" || frame.success !== true)
				return fail(`get_state ${sample + 1} failed: ${JSON.stringify(frame).slice(0, 300)}`);
			if (took > MAX_ANSWER_MS)
				return fail(
					`get_state ${sample + 1} took ${Math.round(took)} ms (at most ${MAX_ANSWER_MS} ms): something blocks the agent's event loop.`,
				);
			await Bun.sleep(SAMPLE_EVERY_MS);
		}
		if (exited) return fail("the agent exited while it was being sampled.");
		if (!/capability:(?:mcps|skills):codex-plugins:start/.test(stderr))
			return fail("Codex plugin discovery never ran, so this check proved nothing.");
		// On Windows the discovery asks Windows where Codex's policy is; that lookup must have run.
		if (process.platform === "win32" && !stderr.includes("codex-plugins:windows-policy:spawned"))
			return fail("the Windows policy lookup never ran, so this check proved nothing.");
		// The runners carry no Codex policy, so a working lookup answers; a broken one fails closed unseen.
		if (process.platform === "win32" && !stderr.includes("codex-plugins:windows-policy:answered"))
			return fail("the Windows policy lookup gave no usable answer.");
		child.stdin.end();
		const code = await within(child.exited, 15_000, "running" as const);
		if (code !== 0)
			return fail(
				code === "running" ? "the agent did not exit after stdin closed." : `the agent exited with code ${code}.`,
			);
		console.log(
			`${launch.label}: ready in ${Math.round(readyMs)} ms; the slowest of ${SAMPLES} get_state answers took ${Math.round(slowest)} ms.`,
		);
		return undefined;
	} finally {
		child.stdin.end();
		if (
			!(await within(
				child.exited.then(() => true),
				15_000,
				false,
			))
		)
			child.kill("SIGKILL");
		await child.exited;
		await Promise.all([stdoutDone, stderrDone]);
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

const failures: string[] = [];
for (const launch of LAUNCHES) {
	const failure = await check(launch);
	if (failure) failures.push(failure);
}
if (failures.length > 0) {
	console.error(failures.join("\n\n"));
	process.exit(1);
}
console.log("Responsiveness check passed.");
