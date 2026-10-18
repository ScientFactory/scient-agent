/**
 * Scient's workflow builds both x86-64 native addons on one runner, the
 * `modern` (AVX2) one and the `baseline` one for processors without AVX2.
 * `PI_NATIVE_X64_VARIANT` (`baseline` or `modern`) names the one to build in
 * place of the host's own detection.
 *
 * @returns whether to build the AVX2 addon, or undefined to detect it
 */
export function forcedAvx2(): boolean | undefined {
	const forced = Bun.env.PI_NATIVE_X64_VARIANT;
	if (!forced) return undefined;
	if (forced === "baseline" || forced === "modern") return forced === "modern";
	throw new Error(`PI_NATIVE_X64_VARIANT must be "baseline" or "modern", not ${JSON.stringify(forced)}`);
}
