// Remote control: a separate browser (standing in for another app's panel)
// loads the media server's /editor URL; MCP tools must then drive that panel.
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { agentDir, connect } from "./mcp-client.mjs";

const media = resolve(agentDir, "out/media");
const configFile = resolve(agentDir, "out/test-panel-config.json");
rmSync(configFile, { force: true });

const check = (condition, label) => {
	console.log(`${condition ? "PASS" : "FAIL"}  ${label}`);
	if (!condition) process.exitCode = 1;
};

const browserPath =
	process.env.OPENCUT_BROWSER ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

const mcp = await connect({ env: { OPENCUT_AGENT_CONFIG: configFile } });
let panel;
try {
	await mcp.tool("set_settings", { server_port: 8798, editor_target: "auto" });
	const server = await mcp.tool("media_server");
	check(server.connected_editors.length === 0, "no panel connected yet");

	// The "app": its own browser profile, so it shares nothing with the agent.
	panel = await chromium.launchPersistentContext(resolve(agentDir, "out/panel-profile"), {
		executablePath: browserPath,
		headless: true,
		viewport: { width: 1400, height: 850 },
		args: ["--enable-unsafe-webgpu"],
	});
	const page = panel.pages()[0] ?? (await panel.newPage());
	await page.goto(server.editor, { timeout: 180_000 });
	await page.waitForFunction(() => window.__opencutAgent?.isReady(), null, { timeout: 180_000 });
	for (let i = 0; i < 20 && (await mcp.tool("media_server", {}, { quiet: true })).connected_editors.length === 0; i++) {
		await new Promise((ok) => setTimeout(ok, 500));
	}
	const connected = (await mcp.tool("media_server", {}, { quiet: true })).connected_editors;
	check(connected.length === 1, "panel connected to the relay");

	const opened = await mcp.tool("open_project", {});
	check(opened.editor === "panel", "tools drive the panel");
	const panelProject = await page.evaluate(() => window.__opencutAgent.getState().projectId);
	check(opened.project_id === panelProject, "same project as the panel shows");

	const clip = await mcp.tool("add_clip", { path: resolve(media, "talk.mp4"), start: 0 });
	const title = await mcp.tool("add_text", { text: "From the agent", start: 0, duration: 3, position: "top" });
	const panelState = await page.evaluate(() => window.__opencutAgent.getState());
	const panelIds = panelState.tracks.flatMap((t) => t.elements.map((e) => e.id));
	check(panelIds.includes(clip.element_id ?? clip.id), "clip appears in the panel");
	check(panelIds.includes(title.element_id ?? title.id), "title appears in the panel");
	check(panelState.media.some((m) => m.name === "talk.mp4"), "file imported via the relay");

	await mcp.tool("preview_frames", { times: [1] }, { quiet: true });
	check(true, "preview frame rendered in the panel");

	const exported = await mcp.tool(
		"export_video",
		{ path: resolve(agentDir, "out/panel-export.mp4"), contact_sheet: false },
		{ quiet: true },
	);
	check(exported.bytes > 10_000, "export streamed back from the panel");

	const fresh = await mcp.tool("new_project", {});
	await page.waitForFunction(() => window.__opencutAgent?.isReady(), null, { timeout: 60_000 });
	const afterSwitch = await page.evaluate(() => window.__opencutAgent.getState().projectId);
	check(fresh.project_id === afterSwitch && afterSwitch !== panelProject, "new_project switches the panel");

	await panel.close();
	panel = null;
	const fallback = await mcp.tool("open_project", {});
	check(fallback.editor === "headless", "falls back to headless when the panel closes");

	const badToken = await fetch(`${server.gallery}control/editors?token=nope`);
	check(badToken.status === 403, "relay rejects a wrong token");
} catch (error) {
	console.error("\nFAILED:", error.message);
	process.exitCode = 1;
} finally {
	await panel?.close().catch(() => {});
	mcp.close();
}
