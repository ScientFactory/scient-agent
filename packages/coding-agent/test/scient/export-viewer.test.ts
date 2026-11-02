import { describe, expect, it } from "bun:test";
import { embeddedExportViewer } from "../../src/scient/export-viewer";

describe("embeddedExportViewer", () => {
	it("has nothing outside a compiled binary", () => {
		expect(embeddedExportViewer("")).toBeUndefined();
	});

	it("keeps the viewer's own text from closing the page's script", () => {
		const script = embeddedExportViewer('const tag = "</script>";');
		expect(script?.match(/<\/script>/g)).toHaveLength(1);
		expect(script).toContain('"<\\/script>"');
	});
});
