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

/** The agent's sign-in list, as a host shows it. */
export function listSignInProviders(authStorage: AuthStorage): RpcLoginProvider[] {
	return getOAuthProviders().map(provider => {
		const storeId = provider.storeCredentialsAs ?? provider.id;
		return {
			id: provider.id,
			name: provider.name,
			available: provider.available,
			authenticated: authStorage.keys.source(storeId) !== undefined,
			kind: signInKind(provider.id),
			stored: authStorage.credentials.has(storeId),
		};
	});
}

/**
 * Removes every stored sign-in of one entry. A key that comes from the
 * environment is not stored and stays; the entry then still lists as
 * `authenticated` with `stored: false`.
 *
 * Returns `false` for an entry the agent does not know. Throws when the store
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
	await authStorage.credentials.revalidate();
	await authStorage.credentials.remove(storeId);
	// `remove` clears this process's copy whatever the store did. Read the store again.
	await authStorage.credentials.revalidate();
	if (authStorage.credentials.has(storeId)) {
		throw new Error(`The stored sign-in for ${providerId} could not be removed. Try again.`);
	}
	return true;
}
