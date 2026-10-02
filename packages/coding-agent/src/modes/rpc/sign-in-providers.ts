import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import type { RpcLoginProvider } from "./rpc-types";

/**
 * The id a sign-in entry's credentials are stored under. Two entries can share
 * one store (the ChatGPT browser and device flows both sign in to
 * `openai-codex`), so status and sign-out follow this id, not the entry's.
 */
export function signInStoreId(providerId: string): string | undefined {
	const provider = getOAuthProviders().find(candidate => candidate.id === providerId);
	return provider ? (provider.storeCredentialsAs ?? provider.id) : undefined;
}

/**
 * Sign-ins implemented by a hook that ask for a pasted key. A hook is how a
 * sign-in is implemented, not what it asks for, so these are named here.
 */
const KEY_HOOKS: ReadonlySet<string> = new Set([
	"alibaba-coding-plan",
	"alibaba-token-plan",
	"cloudflare-ai-gateway",
	"xiaomi",
]);

/** Whether an entry signs in with an account or asks for a pasted key. */
export function signInKind(providerId: string): RpcLoginProvider["kind"] {
	const login = authPolicyFor(providerId)?.login;
	// An entry an extension registered has no auth policy: it signs in with an account.
	if (login === undefined) return "account";
	if (login.kind === "api-key") return "key";
	return login.kind === "custom" && KEY_HOOKS.has(login.hook) ? "key" : "account";
}

/**
 * With an auth broker the broker holds the sign-ins, and this process only has
 * a snapshot of them, in memory and cached on disk. Removing one here cannot
 * promise that the next process will not find it again, so over RPC a broker's
 * sign-ins are listed as not removable and a sign-out is refused. The store
 * that is active decides this (`credentials.heldByBroker`), not the
 * configuration: after a failed switch between stores the two can disagree.
 */
export const BROKER_SIGN_OUT_REFUSAL =
	"Sign-ins are held by the auth broker this agent is connected to. Sign out there.";

/** The agent's sign-in list, as a host shows it. */
export function listSignInProviders(authStorage: AuthStorage): RpcLoginProvider[] {
	const heldByBroker = authStorage.credentials.heldByBroker;
	return getOAuthProviders().map(provider => {
		const storeId = provider.storeCredentialsAs ?? provider.id;
		return {
			id: provider.id,
			name: provider.name,
			available: provider.available,
			authenticated: authStorage.keys.source(storeId) !== undefined,
			kind: signInKind(provider.id),
			stored: !heldByBroker && authStorage.credentials.has(storeId),
		};
	});
}

/**
 * Removes every stored sign-in of one entry. A key that comes from the
 * environment is not stored and stays; the entry then still lists as
 * `authenticated` with `stored: false`.
 *
 * Returns `false` for an entry the agent does not know. Throws with an auth
 * broker (see {@link BROKER_SIGN_OUT_REFUSAL}). Throws when the store
 * still holds the sign-in afterwards: both stores swallow a failed delete (a
 * locked database, a broker that refused), and a host must not be told a
 * sign-in is gone while the next process would still find it. `revalidate`
 * reads the store itself; with an auth broker, `reload` would only read the
 * local snapshot the failed delete already emptied.
 */
export async function removeStoredSignIn(
	authStorage: Pick<AuthStorage, "credentials">,
	providerId: string,
): Promise<boolean> {
	const storeId = signInStoreId(providerId);
	if (storeId === undefined) return false;
	if (authStorage.credentials.heldByBroker) throw new Error(BROKER_SIGN_OUT_REFUSAL);
	await authStorage.credentials.revalidate();
	await authStorage.credentials.remove(storeId);
	// `remove` clears this process's copy whatever the store did. Read the store again.
	await authStorage.credentials.revalidate();
	if (authStorage.credentials.has(storeId)) {
		throw new Error(`The stored sign-in for ${providerId} could not be removed. Try again.`);
	}
	return true;
}
