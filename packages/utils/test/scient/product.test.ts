import { describe, expect, it } from "bun:test";
import { APP_NAME, USER_AGENT, VERSION } from "@oh-my-pi/pi-utils/dirs";
import { PRODUCT_VERSION, UPSTREAM } from "@oh-my-pi/pi-utils/scient/product";
import scient from "../../../../scient.json" with { type: "json" };

describe("Scient Agent's product identity", () => {
	it("names the executable as scient.json does", () => {
		// The identity generator writes APP_NAME; scient.json is what a release is checked against.
		expect(APP_NAME).toBe(scient.name);
	});

	it("reports its own release, not the Oh My Pi packages' version", () => {
		expect(PRODUCT_VERSION).toBe(scient.version);
		expect(USER_AGENT).toBe(`${APP_NAME}/${PRODUCT_VERSION}`);
		expect(VERSION).toBe(UPSTREAM.version);
	});

	it("pins an exact Oh My Pi commit", () => {
		expect(UPSTREAM.name).toBe("oh-my-pi");
		expect(UPSTREAM.commit).toMatch(/^[0-9a-f]{40}$/);
	});
});
