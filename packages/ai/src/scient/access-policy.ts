/**
 * Provider refusals that name an access policy, not a bad credential.
 *
 * OpenRouter serves some free models only to the apps it lists, and refuses any other client with a
 * 403: "thinkingmachines/inkling-2-small:free is only available on agentic harnesses. Try plugging
 * it into a coding agent or productivity app listed on https://openrouter.ai/apps". The key is
 * valid. Oh My Pi reads a bare 403 as a failed sign-in, so the person was told to fix a key that
 * works. The classifier marks the refusal an account policy instead, as it does Anthropic's
 * organization denials.
 */

const HARNESS_ONLY_MODEL_PATTERN = /\bis only available on agentic harnesses\b/i;

/** Whether `text` is a provider's refusal to serve a model outside the apps it lists. */
export function isAppRestrictedModelText(text: string): boolean {
	return HARNESS_ONLY_MODEL_PATTERN.test(text);
}
