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
 * other providers discovered stay as they are. The provider is rediscovered
 * only when it had no usable model: a discovery that fails can replace a
 * provider's discovered models with a partial cached list, and a provider that
 * was working has models to lose that way.
 *
 * Never throws: the caller reports the model as missing if this did not help.
 */
export async function reloadSignIns(registry: ModelRegistry, providerId: string): Promise<void> {
	const hadUsableModels = registry.getAvailable().some(model => model.provider === providerId);
	try {
		await registry.authStorage.credentials.reload();
	} catch (err) {
		logger.warn("Reloading sign-ins for a missing model failed", { provider: providerId, err });
		return;
	}
	if (!hadUsableModels) {
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
