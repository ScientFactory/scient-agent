/**
 * Check for and install updates.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { updateHelp as commandHelp } from "../cli/command-help";
import * as pluginCli from "../cli/plugin-cli";
import { CliUsageError } from "../cli/usage-error";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

export default class Update extends Command {
	static description = commandHelp.description;
	static flags = {
		force: Flags.boolean({ char: "f", description: "Force update", default: false }),
		check: Flags.boolean({ char: "c", description: "Check for updates without installing", default: false }),
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
		canary: Flags.boolean({ description: "Switch to the canary channel and update", default: false }),
		stable: Flags.boolean({ description: "Switch back to the stable channel", default: false }),
	};

	static examples = [`${APP_NAME} update --plugins`];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		await initTheme();
		if (flags.canary && flags.stable) throw new CliUsageError("--canary and --stable are mutually exclusive");
		if (flags.plugins) {
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: {} });
		} else {
			// The inherited self-updater installs Oh My Pi releases; running it here
			// would replace Scient Agent with a different product.
			throw new CliUsageError(
				`${APP_NAME} does not update itself. Scient updates it, or install a newer release. Use \`${APP_NAME} update --plugins\` for plugins.`,
			);
		}
	}
}
