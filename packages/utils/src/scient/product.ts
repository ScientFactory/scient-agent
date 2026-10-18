/**
 * Scient Agent's own release, as `scient.json` records it. `VERSION` in
 * `dirs.ts` stays the version of the inherited Oh My Pi packages: internal
 * compatibility checks, the native addon's stamp among them, compare against it.
 */
import scient from "../../../../scient.json" with { type: "json" };

/** Scient Agent's release version (e.g. "0.1.0"): what `--version` and the User-Agent report. */
export const PRODUCT_VERSION: string = scient.version;

/** The Oh My Pi release this build derives from. */
export const UPSTREAM: { readonly name: string; readonly version: string; readonly commit: string } = scient.upstream;
