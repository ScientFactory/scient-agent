import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import {
	closeLaunchedBrowser,
	ensureChromiumExecutable,
	RENDERER_PRIORITY_ARGS,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { unpackedExtensionId } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/extension-files";
import { waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import { startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import puppeteer from "puppeteer-core";
import { chromiumAvailable } from "../tools/chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const ASSETS = path.resolve(import.meta.dir, "../../src/tools/browser/relay/extension-assets");
/** Before the fix, the duplicate sockets of a first start reached the relay within 60 ms of the first one. */
const SETTLE_MS = 1_500;

describe.skipIf(!CHROMIUM_AVAILABLE)("relay extension connection", () => {
	it("opens one socket and sends one hello on a first start, and reconnects only when a setting changes", async () => {
		const port = await findFreeCdpPort();
		let sockets = 0;
		let hellos = 0;
		const server = startRelayServer({
			port,
			group: false,
			log: message => {
				if (message === "extension socket connected") sockets++;
				if (message === "extension connected") hellos++;
			},
		});
		const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "scient-relay-connect-"));
		const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "scient-relay-connect-profile-"));
		let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
		let next: ReturnType<typeof startRelayServer> | undefined;
		try {
			for (const file of ["manifest.json", "options.html", "options.js"]) {
				await fs.copyFile(path.join(ASSETS, `${file}.txt`), path.join(extensionDir, file));
			}
			const background = await fs.readFile(path.join(ASSETS, "background.js.txt"), "utf8");
			const defaultPort = "var DEFAULT_PORT = 9324;";
			expect(background).toContain(defaultPort);
			await fs.writeFile(
				path.join(extensionDir, "background.js"),
				background.replace(defaultPort, `var DEFAULT_PORT = ${port};`),
			);
			// A fresh profile: Chrome installs the extension, so its worker starts with onInstalled beside its own
			// connect(), and writes its instance id to storage for the first time.
			browser = await puppeteer.launch({
				executablePath: await ensureChromiumExecutable(),
				headless: true,
				pipe: true,
				userDataDir,
				enableExtensions: [extensionDir],
				args: ["--no-first-run", "--no-default-browser-check", "--use-mock-keychain", ...RENDERER_PRIORITY_ARGS],
			});
			expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toBe("ready");
			await Bun.sleep(SETTLE_MS);
			expect({ sockets, hellos }).toEqual({ sockets: 1, hellos: 1 });

			// Storage the extension keeps beside its settings is not a settings change.
			const extensionId = await unpackedExtensionId(extensionDir);
			if (!extensionId) throw new Error("Missing relay extension directory");
			const page = await browser.newPage();
			const deadline = Date.now() + 10_000;
			for (;;) {
				try {
					await page.goto(`chrome-extension://${extensionId}/options.html`);
					break;
				} catch (error) {
					if (!String(error).includes("ERR_BLOCKED_BY_CLIENT") || Date.now() > deadline) throw error;
					await Bun.sleep(50);
				}
			}
			const cdp = await page.createCDPSession();
			const { exceptionDetails } = await cdp.send("Runtime.evaluate", {
				expression: 'chrome.storage.local.set({ scientTestValue: "changed" })',
				awaitPromise: true,
			});
			expect(exceptionDetails).toBeUndefined();
			await Bun.sleep(SETTLE_MS);
			expect({ sockets, hellos }).toEqual({ sockets: 1, hellos: 1 });

			// A new port still moves the extension to the relay there.
			const nextPort = await findFreeCdpPort();
			next = startRelayServer({ port: nextPort, group: false });
			await cdp.send("Runtime.evaluate", {
				expression: `chrome.storage.local.set({ port: ${nextPort} })`,
				awaitPromise: true,
			});
			expect(await waitForRelayExtension(`http://127.0.0.1:${nextPort}`)).toBe("ready");
		} finally {
			if (browser) await closeLaunchedBrowser(browser);
			server.stop();
			next?.stop();
			await fs.rm(extensionDir, { recursive: true, force: true });
			await fs.rm(userDataDir, { recursive: true, force: true });
		}
	}, 60_000);
});
