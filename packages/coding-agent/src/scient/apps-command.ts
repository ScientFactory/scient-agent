/**
 * `scient-agent apps`: the ChatGPT apps the stored ChatGPT sign-in has connected. With --json it
 * prints `{ "apps": [{ "id", "name", "description"?, "tools", "readOnlyTools" }] }`, or
 * `{ "error": { "kind", "message" } }` and exits 1, for a host that shows the apps itself.
 */
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";
import { ChatGptAppsClient, ChatGptAppsError } from "./chatgpt-apps";
import { appsHelp } from "./command-help";

export default class Apps extends Command {
	static description = appsHelp.description;
	static flags = {
		json: Flags.boolean({ description: "Print one JSON document" }),
	};
	static examples = ["scient-agent apps", "scient-agent apps --json"];

	async run(): Promise<void> {
		const { flags } = await this.parse(Apps);
		const settings = await Settings.loadReadOnly();
		const authStorage = await discoverAuthStorage(undefined, { settings });
		try {
			const apps = (await new ChatGptAppsClient(authStorage).listApps()).map(app => ({
				id: app.id,
				name: app.name,
				...(app.description ? { description: app.description } : {}),
				tools: app.tools.length,
				readOnlyTools: app.tools.filter(tool => tool.readOnly).length,
			}));
			if (flags.json) process.stdout.write(`${JSON.stringify({ apps })}\n`);
			else for (const app of apps) process.stdout.write(`${app.name} (${app.id}): ${app.tools} tools\n`);
		} catch (error) {
			const kind = error instanceof ChatGptAppsError ? error.kind : "unavailable";
			const message = error instanceof ChatGptAppsError ? error.message : "Listing ChatGPT apps failed.";
			if (flags.json) process.stdout.write(`${JSON.stringify({ error: { kind, message } })}\n`);
			else process.stderr.write(`error: ${message}\n`);
			process.exitCode = 1;
		} finally {
			authStorage.close();
		}
	}
}
