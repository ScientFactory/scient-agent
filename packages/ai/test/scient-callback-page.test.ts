import { describe, expect, it } from "bun:test";
import { OAuthCallbackFlow } from "@oh-my-pi/pi-ai/registry/oauth/callback-server";
import type { OAuthAuthInfo, OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { SCIENT_AGENT_SYMBOL_SVG } from "@oh-my-pi/pi-utils/brand";

class PageProbeFlow extends OAuthCallbackFlow {
	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
		const url = new URL("https://provider.example.com/authorize");
		url.searchParams.set("redirect_uri", redirectUri);
		url.searchParams.set("state", state);
		return { url: url.toString() };
	}

	async exchangeToken(code: string): Promise<OAuthCredentials> {
		return { access: code, refresh: "refresh", expires: Date.now() + 60_000 };
	}
}

/** Oh My Pi's mark, drawn by the page before Scient Agent had its own. */
const OH_MY_PI_MARK = "M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z";

describe("sign-in callback page", () => {
	it("shows Scient Agent's symbol after a sign-in, and not the π mark it showed before", async () => {
		const abort = new AbortController();
		const authFired = Promise.withResolvers<OAuthAuthInfo>();
		const flow = new PageProbeFlow(
			{ onAuth: info => authFired.resolve(info), signal: abort.signal },
			{ preferredPort: 0 },
		);
		const login = flow.login();
		void login.catch(() => undefined);
		const authUrl = new URL((await authFired.promise).url);
		const redirectUri = authUrl.searchParams.get("redirect_uri");
		const state = authUrl.searchParams.get("state");
		if (!redirectUri || !state) throw new Error("the flow did not advertise its callback parameters");
		try {
			const page = await (await fetch(`${redirectUri}?code=code&state=${encodeURIComponent(state)}`)).text();
			expect(page).toContain(SCIENT_AGENT_SYMBOL_SVG);
			expect(page).not.toContain("__SCIENT_AGENT_SYMBOL__");
			expect(page).not.toContain(OH_MY_PI_MARK);
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});
});
