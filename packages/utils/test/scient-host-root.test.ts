import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";

/**
 * A host (Scient Desktop) assigns the config root with SCIENT_AGENT_ROOT. These
 * tests run a probe in a child process, because `env.ts` and `dirs.ts` resolve
 * the environment once, at import.
 */
const envUrl = url.pathToFileURL(path.join(import.meta.dir, "..", "src", "env.ts")).href;
const dirsUrl = url.pathToFileURL(path.join(import.meta.dir, "..", "src", "dirs.ts")).href;

const AGENT_VARIABLES = [
	"SCIENT_AGENT_ROOT",
	"SCIENT_AGENT_DIR",
	"SCIENT_AGENT_CONFIG_DIR",
	"SCIENT_AGENT_CONFIG_FILES",
	"SCIENT_AGENT_PROFILE",
	"SCIENT_AGENT_PROFILE_FALLBACK",
	"SCIENT_AGENT_SESSION_DIR",
	"SCIENT_AGENT_AUTH_BROKER_URL",
	"SCIENT_AGENT_NATIVES_DIR",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
];

interface Probe {
	readonly agentDir: string;
	readonly configRoot: string;
	readonly nativesDir: string;
	readonly env: Record<string, string | null>;
}

const scratchDirs: string[] = [];
afterEach(async () => {
	await Promise.all(scratchDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<{ home: string; project: string; root: string; elsewhere: string }> {
	const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "scient-host-root-")));
	scratchDirs.push(base);
	const dirs = {
		home: path.join(base, "home"),
		project: path.join(base, "project"),
		root: path.join(base, "root"),
		elsewhere: path.join(base, "elsewhere"),
	};
	await Promise.all(
		[dirs.home, dirs.project, path.join(dirs.root, "agent")].map(dir => fs.mkdir(dir, { recursive: true })),
	);
	return dirs;
}

/** Imports env.ts and dirs.ts in a child started in `project`, and reports what they resolved. */
async function probe(dirs: { home: string; project: string }, launch: Record<string, string>): Promise<Probe> {
	const script = [
		`import { $env } from ${JSON.stringify(envUrl)};`,
		`import { getAgentDir, getConfigRootDir, getNativesDir } from ${JSON.stringify(dirsUrl)};`,
		`const names = ${JSON.stringify(AGENT_VARIABLES)};`,
		"process.stdout.write(JSON.stringify({",
		"nativesDir: getNativesDir(),",
		"	agentDir: getAgentDir(),",
		"	configRoot: getConfigRootDir(),",
		"	env: Object.fromEntries(names.map(name => [name, $env[name] ?? null])),",
		"}));",
	].join("\n");
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: dirs.home,
		USERPROFILE: dirs.home,
		...launch,
	};
	for (const name of AGENT_VARIABLES) if (!(name in launch)) delete env[name];
	// `--no-env-file`: the compiled agent does not let Bun load `.env` by itself
	// either, so `env.ts` is the only reader, as in a release build.
	const proc = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "--eval", script], {
		cwd: dirs.project,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as Probe;
}

const dotenv = (values: Record<string, string>) =>
	`${Object.entries(values)
		.map(([name, value]) => `${name}=${value}`)
		.join("\n")}\n`;

describe("host-assigned config root", () => {
	it.each(["project", "home"] as const)(
		"keeps the agent directory under the root when the %s .env names another one",
		async where => {
			const dirs = await scratch();
			await Bun.write(
				path.join(dirs[where], ".env"),
				dotenv({ SCIENT_AGENT_DIR: path.join(dirs.elsewhere, "agent"), UNRELATED_VALUE: "kept" }),
			);
			const result = await probe(dirs, { SCIENT_AGENT_ROOT: dirs.root });
			expect(result.configRoot).toBe(dirs.root);
			expect(result.agentDir).toBe(path.join(dirs.root, "agent"));
			expect(result.env.SCIENT_AGENT_DIR).toBeNull();
		},
	);

	it("ignores an agent directory inherited beside the root", async () => {
		const dirs = await scratch();
		const result = await probe(dirs, {
			SCIENT_AGENT_ROOT: dirs.root,
			SCIENT_AGENT_DIR: path.join(dirs.elsewhere, "agent"),
		});
		expect(result.agentDir).toBe(path.join(dirs.root, "agent"));
	});

	it("keeps native state inside the host root despite native and XDG overrides", async () => {
		const dirs = await scratch();
		const result = await probe(dirs, {
			SCIENT_AGENT_ROOT: dirs.root,
			SCIENT_AGENT_NATIVES_DIR: path.join(dirs.elsewhere, "natives"),
			XDG_CACHE_HOME: path.join(dirs.elsewhere, "cache"),
		});
		expect(result.nativesDir).toBe(path.join(dirs.root, "natives"));
	});

	it("does not take the agent's own variables from a .env outside the root", async () => {
		const dirs = await scratch();
		const outside = {
			SCIENT_AGENT_SESSION_DIR: path.join(dirs.elsewhere, "sessions"),
			SCIENT_AGENT_CONFIG_FILES: path.join(dirs.elsewhere, "overlay.yml"),
			SCIENT_AGENT_CONFIG_DIR: ".elsewhere",
			SCIENT_AGENT_PROFILE: "elsewhere",
			SCIENT_AGENT_AUTH_BROKER_URL: "https://broker.invalid",
		};
		await Bun.write(path.join(dirs.project, ".env"), dotenv(outside));
		await Bun.write(path.join(dirs.home, ".env"), dotenv(outside));
		const result = await probe(dirs, { SCIENT_AGENT_ROOT: dirs.root });
		for (const name of Object.keys(outside)) expect(result.env[name], name).toBeNull();
		expect(result.agentDir).toBe(path.join(dirs.root, "agent"));
	});

	it("still takes other variables from those files, and the agent's own from a .env inside the root", async () => {
		const dirs = await scratch();
		const sessions = path.join(dirs.root, "sessions");
		await Bun.write(path.join(dirs.project, ".env"), dotenv({ XDG_STATE_HOME: path.join(dirs.elsewhere, "state") }));
		await Bun.write(path.join(dirs.root, "agent", ".env"), dotenv({ SCIENT_AGENT_SESSION_DIR: sessions }));
		const result = await probe(dirs, { SCIENT_AGENT_ROOT: dirs.root });
		expect(result.env.XDG_STATE_HOME).toBe(path.join(dirs.elsewhere, "state"));
		expect(result.env.SCIENT_AGENT_SESSION_DIR).toBe(sessions);
	});

	it("leaves a standalone agent's .env overrides alone", async () => {
		const dirs = await scratch();
		const agentDir = path.join(dirs.elsewhere, "agent");
		const sessions = path.join(dirs.elsewhere, "sessions");
		await Bun.write(
			path.join(dirs.project, ".env"),
			dotenv({ SCIENT_AGENT_DIR: agentDir, SCIENT_AGENT_SESSION_DIR: sessions }),
		);
		const result = await probe(dirs, {});
		expect(result.agentDir).toBe(agentDir);
		expect(result.env.SCIENT_AGENT_SESSION_DIR).toBe(sessions);
	});

	it("does not take a root from a .env", async () => {
		const dirs = await scratch();
		await Bun.write(path.join(dirs.project, ".env"), dotenv({ SCIENT_AGENT_ROOT: dirs.root }));
		await Bun.write(path.join(dirs.home, ".env"), dotenv({ SCIENT_AGENT_ROOT: dirs.root }));
		const result = await probe(dirs, {});
		expect(result.env.SCIENT_AGENT_ROOT).toBeNull();
		expect(result.configRoot).toBe(path.join(dirs.home, ".scient-agent"));
	});

	it("does not treat a relative root as an assignment", async () => {
		const dirs = await scratch();
		const agentDir = path.join(dirs.elsewhere, "agent");
		await Bun.write(path.join(dirs.project, ".env"), dotenv({ SCIENT_AGENT_DIR: agentDir }));
		const result = await probe(dirs, { SCIENT_AGENT_ROOT: "relative/root" });
		expect(result.agentDir).toBe(agentDir);
	});
});
