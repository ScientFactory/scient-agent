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
 * Nothing that was usable is lost. No static reload runs, so the catalogs
 * other providers discovered stay as they are. The provider itself is
 * rediscovered only when this session holds no discovered catalog for it: a
 * discovery that fails can replace a discovered catalog with a partial cached
 * list, so one that is already here is left alone. A model that only a second
 * account of an already discovered provider has is therefore still reported
 * missing until the session restarts.
 *
 * Never throws: the caller reports the model as missing if this did not help.
 */
export async function reloadSignIns(registry: ModelRegistry, providerId: string): Promise<void> {
	try {
		await registry.authStorage.credentials.reload();
	} catch (err) {
		logger.warn("Reloading sign-ins for a missing model failed", { provider: providerId, err });
		return;
	}
	const discovery = registry.getProviderDiscoveryState(providerId)?.status;
	if (discovery !== "ok" && discovery !== "cached") {
		try {
			// Models this provider only lists for a signed-in account.
			await registry.refreshDiscoverableProviders([providerId], "online");
		} catch (err) {
			logger.warn("Rediscovering models after reloading sign-ins failed", { provider: providerId, err });
		}
	}
	// Catalogs a provider builds from its sign-in, whether or not it discovers any.
	registry.reapplySignInProjections();
}
