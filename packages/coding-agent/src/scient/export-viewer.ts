/**
 * The HTML export viewer a compiled Scient Agent carries. Oh My Pi's binaries
 * point exports at the viewer it hosts, and that file is Oh My Pi's: Scient's
 * own viewer differs by its wording, so the build embeds it instead
 * (`SCIENT_EXPORT_VIEWER`, defined in compile-binary.ts).
 */

/** The viewer as an inline script for an exported page, or undefined outside a compiled binary. */
export function embeddedExportViewer(viewer = process.env.SCIENT_EXPORT_VIEWER): string | undefined {
	if (!viewer) return undefined;
	// Same as a source checkout's inline viewer: it waits for the deferred libraries.
	const escaped = viewer.replace(/<\/script/gi, match => `<\\/${match.slice(2)}`);
	return `<script>window.addEventListener("DOMContentLoaded",function(){\n${escaped}\n});</script>`;
}
