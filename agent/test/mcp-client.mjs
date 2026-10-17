// Minimal MCP stdio client for tests: spawns mcp-server.mjs and calls tools.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function connect({ imagesDir, env = {} } = {}) {
	const server = spawn(process.execPath, [resolve(agentDir, "mcp-server.mjs")], {
		stdio: ["pipe", "pipe", "inherit"],
		env: { ...process.env, ...env },
	});
	const pending = new Map();
	let nextId = 1;
	createInterface({ input: server.stdout }).on("line", (line) => {
		const message = JSON.parse(line);
		pending.get(message.id)?.(message);
		pending.delete(message.id);
	});
	const request = (method, params) => {
		const id = nextId++;
		server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		return new Promise((ok) => pending.set(id, ok));
	};

	await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "test", version: "0" },
	});
	server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	let imageCount = 0;
	async function tool(name, args = {}, { quiet = false } = {}) {
		const started = Date.now();
		const { result, error } = await request("tools/call", { name, arguments: args });
		if (error) throw new Error(`${name}: protocol error ${error.message}`);
		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		console.log(`\n== ${name} (${seconds}s)${result.isError ? "  ** ERROR **" : ""}`);
		for (const item of result.content) {
			if (item.type === "text" && !quiet) {
				console.log(item.text.length > 1500 ? `${item.text.slice(0, 1500)}...` : item.text);
			} else if (item.type === "image" && imagesDir) {
				mkdirSync(imagesDir, { recursive: true });
				const file = resolve(imagesDir, `${++imageCount}-${name}.${item.mimeType.split("/")[1]}`);
				writeFileSync(file, Buffer.from(item.data, "base64"));
				console.log(`[image] ${file}`);
			}
		}
		if (result.isError) throw new Error(`${name} failed: ${result.content[0]?.text}`);
		const textItem = result.content.find((item) => item.type === "text")?.text;
		try {
			return JSON.parse(textItem);
		} catch {
			return textItem;
		}
	}

	return {
		request,
		tool,
		close() {
			server.stdin.end();
			setTimeout(() => process.exit(), 4000).unref();
		},
	};
}
