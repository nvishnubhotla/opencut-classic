// Drives mcp-server.mjs over stdio like an MCP client would, running a
// realistic edit. Images returned by tools are saved to out/mcp-e2e/.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const media = resolve(agentDir, "out/media");
const outDir = resolve(agentDir, "out/mcp-e2e");
mkdirSync(outDir, { recursive: true });

const server = spawn(process.execPath, [resolve(agentDir, "mcp-server.mjs")], {
	stdio: ["pipe", "pipe", "inherit"],
});
const pending = new Map();
let nextId = 1;
createInterface({ input: server.stdout }).on("line", (line) => {
	const message = JSON.parse(line);
	pending.get(message.id)?.(message);
	pending.delete(message.id);
});

function request(method, params) {
	const id = nextId++;
	server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
	return new Promise((ok) => pending.set(id, ok));
}

let imageCount = 0;
async function tool(name, args = {}) {
	const started = Date.now();
	const { result, error } = await request("tools/call", { name, arguments: args });
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	if (error) throw new Error(`${name}: protocol error ${error.message}`);
	console.log(`\n== ${name} (${seconds}s)${result.isError ? "  ** ERROR **" : ""}`);
	for (const item of result.content) {
		if (item.type === "text") {
			console.log(item.text.length > 1200 ? `${item.text.slice(0, 1200)}...` : item.text);
		} else if (item.type === "image") {
			const file = resolve(outDir, `${++imageCount}-${name}.${item.mimeType.split("/")[1]}`);
			writeFileSync(file, Buffer.from(item.data, "base64"));
			console.log(`[image] ${file}`);
		}
	}
	if (result.isError) throw new Error(`${name} failed`);
	const textItem = result.content.find((item) => item.type === "text")?.text;
	try {
		return JSON.parse(textItem);
	} catch {
		return textItem;
	}
}

try {
	const init = await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "e2e", version: "0" },
	});
	console.log("server:", init.result.serverInfo);
	server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
	const { result } = await request("tools/list");
	console.log("tools:", result.tools.map((t) => t.name).join(", "));

	const cut = await tool("cut_silences", { input: `${media}/talk.mp4` });

	await tool("open_project", { name: "MCP e2e" });
	const main = await tool("add_clip", { path: cut.output, start: 0 });
	await tool("set_properties", { element_id: main.element_id, volume_db: 4 });

	await tool("add_text", {
		text: "Episode 1",
		start: 0,
		duration: 3,
		position: "top",
		font_size: 18,
		background_color: "#000000",
	});
	const gif = await tool("add_clip", {
		path: `${media}/ball.gif`,
		start: 1,
		duration: 3,
		track: "new",
		scale: 0.3,
		x: 500,
		y: 220,
		blend_mode: "screen",
	});
	await tool("add_sound_effect", { path: `${media}/beep.wav`, at: 2, volume_db: -6 });

	await tool("zoom", {
		element_id: main.element_id,
		start: 2,
		end: 5,
		scale: 1.8,
		focus_x: 0.25,
		focus_y: 0.25,
	});
	await tool("fade", { element_id: main.element_id, fade_in: 0.5, fade_out: 0.5 });
	await tool("reorder_track", { track_id: gif.track_id, to_index: 0 });

	await tool("get_timeline");
	await tool("preview_frames", { times: [0.1, 1.5, 3.5] });
	await tool("export_video", { path: `${outDir}/result.mp4` });
} catch (error) {
	console.error("\nE2E FAILED:", error.message);
	process.exitCode = 1;
} finally {
	server.stdin.end();
	setTimeout(() => process.exit(), 5000).unref();
}
