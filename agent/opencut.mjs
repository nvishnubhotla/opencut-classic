// Node-side client for the dev-only editor bridge (apps/web/src/agent-bridge).
// Launches a Chromium browser, opens the editor, and proxies calls to
// window.__opencutAgent. All times are seconds.
import { chromium } from "playwright-core";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const AGENT_DIR = dirname(fileURLToPath(import.meta.url));
const FILE_INPUT_SELECTOR = "#__opencut-agent-file-input";

const BROWSER_CANDIDATES = [
	process.env.OPENCUT_BROWSER,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	`${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);

function findBrowser() {
	const found = BROWSER_CANDIDATES.find((path) => existsSync(path));
	if (!found) {
		throw new Error(
			"No Chrome or Edge found; set OPENCUT_BROWSER to a Chromium executable",
		);
	}
	return found;
}

export async function launch({
	baseUrl = "http://localhost:3000",
	projectId,
	headless = true,
	userDataDir = resolve(AGENT_DIR, "out/browser-profile"),
	timeoutMs = 180_000,
} = {}) {
	// A persistent profile keeps projects and media (IndexedDB/OPFS) between runs.
	const context = await chromium.launchPersistentContext(userDataDir, {
		executablePath: findBrowser(),
		headless,
		viewport: { width: 1600, height: 900 },
		args: ["--enable-unsafe-webgpu", "--autoplay-policy=no-user-gesture-required"],
	});
	const page = context.pages()[0] ?? (await context.newPage());
	const logs = [];
	page.on("console", (message) => {
		if (message.type() === "error" || message.type() === "warning") {
			logs.push(`[${message.type()}] ${message.text()}`);
		}
	});
	page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}`));

	// An unknown project id makes the editor create a new project and redirect.
	const openProject = async (id) => {
		await page.goto(`${baseUrl}/editor/${id ?? randomUUID()}`, {
			timeout: timeoutMs,
		});
		await page.waitForFunction(() => window.__opencutAgent?.isReady(), null, {
			timeout: timeoutMs,
		});
	};
	await openProject(projectId);

	const call = (method, args) =>
		page.evaluate(
			([name, params]) => window.__opencutAgent[name](params),
			[method, args],
		);

	return {
		page,
		logs,
		call,
		openProject,
		getState: () => call("getState"),
		getElement: (args) => call("getElement", args),
		addMedia: (args) => call("addMedia", args),
		addText: (args) => call("addText", args),
		trim: (args) => call("trim", args),
		split: (args) => call("split", args),
		move: (args) => call("move", args),
		remove: (args) => call("remove", args),
		setParams: (args) => call("setParams", args),
		setVolume: (args) => call("setVolume", args),
		setKeyframes: (args) => call("setKeyframes", args),
		removeTrack: (args) => call("removeTrack", args),
		reorderTrack: (args) => call("reorderTrack", args),
		renderFrame: (args) => call("renderFrame", args),
		listProjects: () => call("listProjects"),
		renameProject: (args) => call("renameProject", args),
		updateSettings: (args) => call("updateSettings", args),
		undo: () => call("undo"),
		redo: () => call("redo"),
		save: () => call("save"),

		/** Imports local files into the project's media library. */
		async importFiles(paths) {
			await page.setInputFiles(
				FILE_INPUT_SELECTOR,
				paths.map((path) => resolve(path)),
			);
			return call("importFiles");
		},

		/** Renders the project and writes it to `outPath`. */
		async exportTo(outPath, options = {}) {
			const info = await call("export", options);
			const parts = [];
			for (let index = 0; index < info.chunks; index++) {
				const chunk = await call("readExportChunk", { index });
				parts.push(Buffer.from(chunk, "base64"));
			}
			const bytes = Buffer.concat(parts);
			await mkdir(dirname(resolve(outPath)), { recursive: true });
			await writeFile(outPath, bytes);
			return { path: resolve(outPath), bytes: bytes.length };
		},

		close: () => context.close(),
	};
}
