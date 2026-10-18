import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigDirs } from "@oh-my-pi/pi-coding-agent/config";
import { __resetDirsFromEnvForTests } from "@oh-my-pi/pi-utils/dirs";

describe("user config under a host-assigned root", () => {
	const saved = { root: process.env.SCIENT_AGENT_ROOT, dir: process.env.SCIENT_AGENT_DIR };
	afterEach(() => {
		for (const [name, value] of [
			["SCIENT_AGENT_ROOT", saved.root],
			["SCIENT_AGENT_DIR", saved.dir],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		__resetDirsFromEnvForTests();
	});

	it("reads the agent's own user config from the root, whatever SCIENT_AGENT_DIR says", () => {
		const root = path.join(os.tmpdir(), "scient-user-config-root");
		process.env.SCIENT_AGENT_ROOT = root;
		process.env.SCIENT_AGENT_DIR = path.join(os.tmpdir(), "scient-user-config-elsewhere");
		__resetDirsFromEnvForTests();
		const [own] = getConfigDirs("commands", { project: false });
		expect(own).toEqual({ path: path.join(root, "agent", "commands"), source: ".scient-agent", level: "user" });
	});
});
