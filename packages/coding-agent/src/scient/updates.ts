import { CliUsageError } from "../cli/usage-error";

/**
 * Scient Agent never updates itself: its host or installer replaces the
 * executable. Oh My Pi's release service describes another product, so the
 * startup update check never asks it, whatever the setting says.
 */
export const SELF_UPDATE: boolean = false;

/**
 * Refuses `update` without `--plugins`. The inherited self-updater installs Oh
 * My Pi releases, so it would replace Scient Agent with another product.
 */
export function refuseSelfUpdate(flags: { readonly plugins: boolean }): void {
	if (!flags.plugins) {
		throw new CliUsageError(
			"scient-agent does not update itself. Scient updates it, or install a newer release. Use `scient-agent update --plugins` for plugins.",
		);
	}
}

/**
 * Refuses the background auto-update worker. Nothing in Scient Agent starts it,
 * but its hidden entry point would otherwise install an Oh My Pi release.
 */
export function refuseAutoUpdateWorker(): void {
	if (!SELF_UPDATE) {
		throw new CliUsageError("scient-agent does not update itself. Scient updates it, or install a newer release.");
	}
}
