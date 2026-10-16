export function hostNativesDir(): string | undefined;

export function addonBuildId(files: ReadonlyArray<{ filename: string; bytes: Uint8Array }>): string;

export function withBuildCache<
	T extends { isCompiledBinary: boolean; platformTag: string; versionedDir: string; candidates: string[] },
>(ctx: T, addon: { platformTag: string; buildId?: string } | null): T;

export interface CleanupStaleNativeBuildsInput {
	/** The package version's folder, holding one folder per build. */
	versionDir: string;
	currentBuildId: string;
}

export function cleanupStaleNativeBuilds(input: CleanupStaleNativeBuildsInput): string[];
