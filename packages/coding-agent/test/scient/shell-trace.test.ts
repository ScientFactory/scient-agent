import { describe, expect, it } from "bun:test";
import { cfgDisplayShellVisualization } from "@oh-my-pi/pi-coding-agent/modes/settings";

describe("bash execution traces", () => {
	it("stay off unless the user turns the shell visualization on", () => {
		expect(cfgDisplayShellVisualization.default).toBe(false);
	});
});
