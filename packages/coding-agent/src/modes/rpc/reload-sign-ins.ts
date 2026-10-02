import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";

/**
 * Re-reads the sign-in store and one provider's models.
 *
 * A session reads its sign-ins once, at startup. One completed afterwards by
 * another process (a terminal `login`, or another conversation's agent under
 * the same host) is in the shared store but not in this session's registry,
 * so its models look missing. A host asks for a model its own fresh check
 * listed; this lets a long-running session find it without a restart.
 *
 * Never throws: the caller reports the model as missing if this did not help.
 */
export async function reloadSignIns(registry: ModelRegistry, providerId: string): Promise<void> {
	try {
		await registry.authStorage.credentials.reload();
		// Only this provider's discovery: `refreshProvider` also reloads the static
		// models, which drops what other providers discovered for their accounts.
		await registry.refreshDiscoverableProviders([providerId], "online");
	} catch (err) {
		logger.warn("Reloading sign-ins for a missing model failed", { provider: providerId, err });
	}
}
