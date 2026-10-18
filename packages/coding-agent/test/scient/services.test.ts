import { describe, expect, it } from "bun:test";
import Update from "@oh-my-pi/pi-coding-agent/commands/update";
import { cfgMarketplaceAutoUpdate, cfgStartupCheckUpdate } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { SELF_UPDATE } from "@oh-my-pi/pi-coding-agent/scient/updates";
import { cfgDevAutoqa } from "@oh-my-pi/pi-coding-agent/tools/settings";

describe("Oh My Pi's services stay off", () => {
	it("never updates itself or asks Oh My Pi's release service", () => {
		expect(SELF_UPDATE).toBe(false);
		expect(cfgStartupCheckUpdate.default).toBe(false);
		expect(Update.examples).toEqual(["scient-agent update --plugins"]);
	});

	it("fetches nothing at startup and reports nothing unless the user asks", () => {
		expect(cfgMarketplaceAutoUpdate.default).toBe("off");
		expect(cfgDevAutoqa.default).toBe(false);
	});
});
