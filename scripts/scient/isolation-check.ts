#!/usr/bin/env bun
/**
 * Checks that a built Scient Agent keeps its own state apart from a stock
 * `omp` on the same machine, and inside the root a host gives it. It starts the
 * executable in RPC mode in empty home directories and fails when the agent:
 *
 * - writes any of its own state outside its config root;
 * - lets a `.env` in the project or the home directory move its state out of
 *   a root a host assigned;
 * - follows one of Oh My Pi's state variables;
 * - creates or changes anything under an Oh My Pi location;
 * - hands its shell a variable that would steer a stock `omp`;
 * - contacts one of Oh My Pi's own services, or an update source, on startup.
 *
 * It tests where the agent keeps its own files and what it contacts unasked.
 * It does not restrict what a task may write or reach: project edits, tool
 * caches, model requests and model discovery are not this check's concern.
 *
 * It runs without a model, so it covers startup, the RPC handshake and the
 * agent's shell. Scient Desktop's live suites cover model turns, subagents,
 * interpreters and sessions against the same executable.
 *
 *   bun scripts/scient/isolation-check.ts <path-to-scient-agent>
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const executable = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
if (!executable || !fs.existsSync(executable)) {
	console.error("usage: bun scripts/scient/isolation-check.ts <path-to-scient-agent>");
	process.exit(2);
}

/** Variables a stock omp reads to choose its state. Scient Agent must ignore them. */
const OMP_SELECTORS = [
	"PI_CONFIG_DIR",
	"PI_CONFIG_FILES",
	"PI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
	"OMP_WORKTREE_DIR",
	"OMP_AUTH_BROKER_URL",
	"OMP_AUTH_BROKER_TOKEN",
	"OMP_GITHUB_CACHE_DB",
	"OMP_COMMIT_CACHE_DB",
	"OMP_JUDGMENT_CACHE_DB",
	"OMP_AUTORESEARCH_DB_DIR",
];
/** Hosts the agent has no business contacting unasked: Oh My Pi's services and update sources. */
const UNEXPECTED_HOSTS = [
	/(^|\.)omp\.sh$/,
	/^registry\.npmjs\.org$/,
	/(^|\.)github\.com$/,
	/(^|\.)githubusercontent\.com$/,
];
const SHELL_ENV_MARKER = "isolation-check-env";

/**
 * No model is configured: over RPC the agent starts without one, and nothing
 * here runs a turn. Local model servers are turned off so a machine that has
 * one behaves like one that does not.
 */
const NO_LOCAL_MODELS_CONFIG = `disabledProviders:
  - ollama
  - llama.cpp
  - lm-studio
`;

function writeAgentConfig(agentDir: string): void {
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(agentDir, "config.yml"), NO_LOCAL_MODELS_CONFIG);
}

const failures: string[] = [];
const fail = (message: string) => failures.push(message);

/** Every path under `root`, relative to it. */
function tree(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			found.push(path.relative(root, full));
			if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
		}
	};
	walk(root);
	return found.sort();
}

/**
 * A proxy that records which hosts the agent tries to reach and connects it
 * to none of them.
 */
function startRecordingProxy(): { url: string; hosts: Set<string>; stop: () => void } {
	const hosts = new Set<string>();
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			data(socket, data) {
				const [method = "", target = ""] = (data.toString("latin1").split("\r\n", 1)[0] ?? "").split(" ");
				const host =
					method === "CONNECT"
						? target.replace(/:\d+$/, "")
						: URL.canParse(target)
							? new URL(target).hostname
							: "";
				if (host) hosts.add(host);
				socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
				socket.end();
			},
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, hosts, stop: () => server.stop(true) };
}

interface RpcRun {
	readonly frames: Record<string, unknown>[];
	readonly stderr: string;
}

/**
 * Starts RPC mode, negotiates v2, runs `env` through the agent's shell, then
 * closes stdin. `session` lets the agent keep a session file, as it does under
 * a host that passes no session directory.
 */
async function runRpc(env: Record<string, string>, cwd: string, session = false): Promise<RpcRun> {
	const child = Bun.spawn(
		[
			executable!,
			"--mode",
			"rpc",
			"--approval-mode",
			"yolo",
			...(session ? [] : ["--no-session"]),
			"--no-extensions",
			"--no-skills",
			"--no-rules",
		],
		{ cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	const frames: Record<string, unknown>[] = [];
	const done = Promise.withResolvers<void>();
	const reader = (async () => {
		let buffer = "";
		const decoder = new TextDecoder();
		for await (const chunk of child.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (!line.trim()) continue;
				try {
					const frame = JSON.parse(line) as Record<string, unknown>;
					frames.push(frame);
					if (frame.type === "response" && frame.id === "env") done.resolve();
				} catch {
					fail(`RPC stdout carried a line that is not JSON: ${line.slice(0, 120)}`);
				}
			}
		}
		done.resolve();
	})();
	child.stdin.write(`${JSON.stringify({ id: "negotiate", type: "negotiate_protocol", protocolVersion: 2 })}\n`);
	child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
	child.stdin.write(`${JSON.stringify({ id: "env", type: "bash", command: `echo ${SHELL_ENV_MARKER}; env` })}\n`);
	await Promise.race([done.promise, Bun.sleep(60_000)]);
	child.stdin.end();
	const exited = await Promise.race([child.exited, Bun.sleep(15_000).then(() => "timeout" as const)]);
	if (exited === "timeout") {
		fail("The agent did not exit after stdin closed.");
		child.kill("SIGKILL");
	}
	await reader;
	return { frames, stderr: await new Response(child.stderr).text() };
}

function response(run: RpcRun, id: string): Record<string, unknown> | undefined {
	return run.frames.find(frame => frame.type === "response" && frame.id === id);
}

function checkProtocol(label: string, run: RpcRun): void {
	const ready = run.frames[0];
	if (ready?.type !== "ready") fail(`${label}: the first RPC frame was not "ready".`);
	for (const id of ["negotiate", "state", "env"]) {
		const frame = response(run, id);
		if (!frame) fail(`${label}: no response to "${id}". stderr: ${run.stderr.slice(-400)}`);
		else if (frame.success !== true) fail(`${label}: "${id}" failed: ${JSON.stringify(frame).slice(0, 300)}`);
	}
}

/** The agent shell's environment, from the `env` output of the bash response. */
function shellEnvironment(run: RpcRun): string[] {
	const text = JSON.stringify(response(run, "env") ?? {});
	const start = text.indexOf(SHELL_ENV_MARKER);
	return start === -1 ? [] : text.slice(start).split("\\n");
}

function checkShellEnvironment(label: string, run: RpcRun, inherited: Record<string, string>): void {
	const lines = shellEnvironment(run);
	if (lines.length === 0) {
		fail(`${label}: the shell environment could not be read.`);
		return;
	}
	for (const name of OMP_SELECTORS) {
		const line = lines.find(entry => entry.startsWith(`${name}=`));
		// A value the user's own environment carried is theirs and passes through
		// unchanged; the agent must never set or rewrite one.
		if (line !== undefined && line !== `${name}=${inherited[name] ?? ""}`) {
			fail(`${label}: the agent's shell has ${line}, which would steer a stock omp.`);
		}
	}
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scient-agent-isolation-"));
try {
	const baseEnv: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		LANG: process.env.LANG ?? "en_US.UTF-8",
		TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
	};

	// 1. Default root: an empty home, with every Oh My Pi selector pointing somewhere else.
	{
		const home = path.join(scratch, "default-home");
		const workspace = path.join(scratch, "default-workspace");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(workspace, { recursive: true });
		writeAgentConfig(path.join(home, ".scient-agent", "agent"));
		const decoy = path.join(scratch, "omp-decoy");
		const ompEnv: Record<string, string> = {
			PI_CONFIG_DIR: ".omp-decoy",
			PI_CONFIG_FILES: path.join(decoy, "overlay.yml"),
			PI_CODING_AGENT_DIR: path.join(decoy, "agent"),
			PI_CODING_AGENT_SESSION_DIR: path.join(decoy, "sessions"),
			OMP_PROFILE: "decoy",
			PI_PROFILE: "decoy",
			OMP_WORKTREE_DIR: path.join(decoy, "wt"),
			OMP_GITHUB_CACHE_DB: path.join(decoy, "github-cache.db"),
			OMP_COMMIT_CACHE_DB: path.join(decoy, "commit-inference.db"),
			OMP_JUDGMENT_CACHE_DB: path.join(decoy, "judgment-cache.db"),
			OMP_AUTORESEARCH_DB_DIR: path.join(decoy, "autoresearch"),
		};
		const proxy = startRecordingProxy();
		const proxyEnv = { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, https_proxy: proxy.url, http_proxy: proxy.url };
		const run = await runRpc({ ...baseEnv, ...ompEnv, ...proxyEnv, HOME: home, USERPROFILE: home }, workspace);
		proxy.stop();
		checkProtocol("default root", run);
		checkShellEnvironment("default root", run, ompEnv);
		console.log(`Hosts contacted on startup: ${[...proxy.hosts].toSorted().join(", ") || "none"}`);
		for (const host of proxy.hosts) {
			if (UNEXPECTED_HOSTS.some(pattern => pattern.test(host))) {
				fail(`default root: the agent contacted ${host} on startup without being asked.`);
			}
		}
		const top = fs.readdirSync(home);
		const strays = top.filter(name => name !== ".scient-agent");
		if (!fs.existsSync(path.join(home, ".scient-agent", "agent", "agent.db"))) {
			fail("default root: the agent did not keep its state in ~/.scient-agent.");
		}
		if (strays.length > 0) fail(`default root: the agent wrote outside ~/.scient-agent: ${strays.join(", ")}`);
		if (fs.existsSync(decoy)) fail(`default root: the agent followed an Oh My Pi variable into ${decoy}.`);
		if (tree(home).some(entry => entry.includes("profiles"))) {
			fail("default root: the agent activated a profile from OMP_PROFILE or PI_PROFILE.");
		}
		if (fs.readdirSync(workspace).length > 0) {
			fail(`default root: starting the agent wrote into the workspace: ${fs.readdirSync(workspace).join(", ")}`);
		}
	}

	// 2. Host-assigned root: an existing Oh My Pi home must stay byte-for-byte untouched.
	{
		const home = path.join(scratch, "host-home");
		const workspace = path.join(scratch, "host-workspace");
		const root = path.join(scratch, "host-root");
		const ompHome = path.join(home, ".omp");
		fs.mkdirSync(path.join(ompHome, "agent"), { recursive: true });
		fs.mkdirSync(path.join(ompHome, "natives", "0.0.1"), { recursive: true });
		fs.writeFileSync(path.join(ompHome, "agent", "config.yml"), "theme: decoy\n");
		fs.writeFileSync(path.join(ompHome, "natives", "0.0.1", "pi_natives.decoy.node"), "decoy");
		// Old enough for the native-cache pruning grace period to have passed.
		const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
		fs.utimesSync(path.join(ompHome, "natives", "0.0.1"), old, old);
		fs.mkdirSync(workspace, { recursive: true });
		writeAgentConfig(path.join(root, "agent"));
		const before = tree(ompHome);

		const run = await runRpc({ ...baseEnv, HOME: home, USERPROFILE: home, SCIENT_AGENT_ROOT: root }, workspace);
		checkProtocol("host root", run);
		checkShellEnvironment("host root", run, {});
		for (const expected of ["agent", "logs", "natives"]) {
			if (!fs.existsSync(path.join(root, expected)))
				fail(`host root: ${expected}/ is missing from SCIENT_AGENT_ROOT.`);
		}
		const after = tree(ompHome);
		if (JSON.stringify(before) !== JSON.stringify(after)) {
			fail(`host root: the Oh My Pi home changed.\nbefore: ${before.join(", ")}\nafter: ${after.join(", ")}`);
		}
		if (fs.readFileSync(path.join(ompHome, "agent", "config.yml"), "utf8") !== "theme: decoy\n") {
			fail("host root: an Oh My Pi config file was rewritten.");
		}
		const strays = fs.readdirSync(home).filter(name => name !== ".omp");
		if (strays.length > 0) {
			fail(
				`host root: with SCIENT_AGENT_ROOT set, the agent still wrote into the home directory: ${strays.join(", ")}`,
			);
		}
	}

	// 3. Host-assigned root, with a project `.env` and a home `.env` that both name
	//    other places for the agent's own state. The host's root must win.
	{
		const home = path.join(scratch, "dotenv-home");
		const workspace = path.join(scratch, "dotenv-workspace");
		const root = path.join(scratch, "dotenv-root");
		const decoy = path.join(scratch, "dotenv-decoy");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(workspace, { recursive: true });
		writeAgentConfig(path.join(root, "agent"));
		const dotenv = [
			`SCIENT_AGENT_DIR=${path.join(decoy, "agent")}`,
			`SCIENT_AGENT_SESSION_DIR=${path.join(decoy, "sessions")}`,
			`SCIENT_AGENT_CONFIG_FILES=${path.join(decoy, "overlay.yml")}`,
			"SCIENT_AGENT_CONFIG_DIR=.dotenv-decoy",
			"SCIENT_AGENT_PROFILE=decoy",
			`SCIENT_AGENT_WORKTREE_DIR=${path.join(decoy, "wt")}`,
			`SCIENT_AGENT_GITHUB_CACHE_DB=${path.join(decoy, "github-cache.db")}`,
			`SCIENT_AGENT_COMMIT_CACHE_DB=${path.join(decoy, "commit-inference.db")}`,
			`SCIENT_AGENT_JUDGMENT_CACHE_DB=${path.join(decoy, "judgment-cache.db")}`,
			`SCIENT_AGENT_AUTORESEARCH_DB_DIR=${path.join(decoy, "autoresearch")}`,
			`XDG_DATA_HOME=${path.join(decoy, "xdg-data")}`,
			`XDG_STATE_HOME=${path.join(decoy, "xdg-state")}`,
			`XDG_CACHE_HOME=${path.join(decoy, "xdg-cache")}`,
			"",
		].join("\n");
		fs.writeFileSync(path.join(workspace, ".env"), dotenv);
		fs.writeFileSync(path.join(home, ".env"), dotenv);

		const run = await runRpc({ ...baseEnv, HOME: home, USERPROFILE: home, SCIENT_AGENT_ROOT: root }, workspace, true);
		checkProtocol("host root with .env files", run);
		if (!fs.existsSync(path.join(root, "agent", "agent.db"))) {
			fail("host root with .env files: the agent did not keep its state in SCIENT_AGENT_ROOT.");
		}
		if (fs.existsSync(decoy)) {
			fail(`host root with .env files: a .env moved the agent's state to ${tree(decoy).join(", ")}.`);
		}
		const state = response(run, "state")?.data as { sessionFile?: string } | undefined;
		if (!state?.sessionFile?.startsWith(root + path.sep)) {
			fail(`host root with .env files: the session file is ${state?.sessionFile ?? "unset"}, outside the root.`);
		}
		if (tree(root).some(entry => entry.split(path.sep).includes("profiles"))) {
			fail("host root with .env files: a .env activated a profile.");
		}
		const homeStrays = fs.readdirSync(home).filter(name => name !== ".env");
		if (homeStrays.length > 0) {
			fail(`host root with .env files: the agent wrote into the home directory: ${homeStrays.join(", ")}`);
		}
		const workspaceStrays = fs.readdirSync(workspace).filter(name => name !== ".env");
		if (workspaceStrays.length > 0) {
			fail(`host root with .env files: starting the agent wrote into the workspace: ${workspaceStrays.join(", ")}`);
		}
	}
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`Isolation check failed (${failures.length}):\n- ${failures.join("\n- ")}`);
	process.exit(1);
}
console.log("Isolation check passed.");
