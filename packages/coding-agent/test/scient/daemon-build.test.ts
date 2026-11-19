import { describe, expect, it } from "bun:test";
import { compareDaemonBuilds } from "../../src/daemon/protocol";

describe("daemon build identity", () => {
	it("puts a newer Scient Agent release ahead of an older one whatever their binaries' file times", () => {
		expect(compareDaemonBuilds("0.1.14+1000", "0.1.13+9999999000")).toBe(1);
	});
});
