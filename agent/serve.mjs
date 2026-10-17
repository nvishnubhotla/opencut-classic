#!/usr/bin/env node
// Media server for agent results. Serves published artifacts with byte-range
// support (seekable video), a JSON API, live updates over SSE, and a gallery.
// Standalone:  node agent/serve.mjs [--port 8787]
// The MCP server starts it in-process when nothing is listening on the port.
import { createReadStream, existsSync, statSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactUrl, listArtifacts, readSession, registryPath } from "./artifacts.mjs";
import { loadConfig } from "./config.mjs";

const MIME = {
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".mkv": "video/x-matroska",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".vtt": "text/vtt; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".html": "text/html; charset=utf-8",
};

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Headers": "*",
	"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
};

function sendJson(res, status, body) {
	res.writeHead(status, { ...CORS, "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body, null, 1));
}

function sendFile(req, res, path) {
	const { size } = statSync(path);
	const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
	const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
	if (range) {
		const start = range[1] ? Number(range[1]) : size - Number(range[2]);
		const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
		if (start >= size || start > end) {
			res.writeHead(416, { ...CORS, "Content-Range": `bytes */${size}` });
			res.end();
			return;
		}
		res.writeHead(206, {
			...CORS,
			"Content-Type": type,
			"Content-Length": end - start + 1,
			"Content-Range": `bytes ${start}-${end}/${size}`,
			"Accept-Ranges": "bytes",
		});
		if (req.method === "HEAD") return res.end();
		createReadStream(path, { start, end }).pipe(res);
		return;
	}
	res.writeHead(200, {
		...CORS,
		"Content-Type": type,
		"Content-Length": size,
		"Accept-Ranges": "bytes",
		"Cache-Control": "no-cache",
	});
	if (req.method === "HEAD") return res.end();
	createReadStream(path).pipe(res);
}

function withUrls(artifacts, port) {
	return artifacts
		.filter((a) => existsSync(a.path))
		.map((a) => ({ ...a, url: artifactUrl(a, { port }) }));
}

const GALLERY = `<!doctype html><meta charset="utf-8"><title>OpenCut results</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#111;--card:#fff;--muted:#666;--line:#ddd}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--card:#1b1b1b;--muted:#999;--line:#333}}
body{margin:0;font:14px system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line)}
header a{color:inherit}main{display:grid;gap:16px;padding:16px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.card video,.card img{width:100%;display:block;background:#000}.card pre{margin:0;padding:8px;max-height:200px;overflow:auto;font-size:12px}
.meta{padding:8px 10px}.meta small{color:var(--muted)}
</style>
<header><b>OpenCut results</b><a id="editor" href="/editor" target="_blank">Open editor</a><small id="status"></small></header>
<main id="list"></main>
<script>
const list = document.getElementById("list");
function card(a) {
  const el = document.createElement("div"); el.className = "card";
  if (a.kind === "video") el.innerHTML = '<video controls preload="metadata"></video>', el.firstChild.src = a.url;
  else if (a.kind === "image") el.innerHTML = '<img loading="lazy">', el.firstChild.src = a.url;
  else if (a.kind === "audio") el.innerHTML = '<audio controls style="width:100%"></audio>', el.firstChild.src = a.url;
  else if (["subtitles","text","data"].includes(a.kind)) {
    const pre = document.createElement("pre"); el.append(pre);
    fetch(a.url).then(r => r.text()).then(t => pre.textContent = t.slice(0, 4000));
  }
  const meta = document.createElement("div"); meta.className = "meta";
  const link = document.createElement("a"); link.href = a.url; link.target = "_blank"; link.textContent = a.title;
  const when = document.createElement("small"); when.textContent = " · " + new Date(a.updated).toLocaleString();
  meta.append(link, when); el.append(meta); return el;
}
async function load() {
  const items = await (await fetch("/api/artifacts")).json();
  list.replaceChildren(...items.map(card));
  const s = await (await fetch("/api/status")).json();
  document.getElementById("status").textContent = s.project_id ? "project " + s.project_id : "";
}
load(); new EventSource("/events").onmessage = load;
</script>`;

export function startServer({ port = loadConfig().server_port } = {}) {
	const clients = new Set();
	const broadcast = () => {
		for (const res of clients) res.write(`data: ${Date.now()}\n\n`);
	};

	// Registry changes come from any process; watch the file and fan out.
	if (!existsSync(registryPath())) writeFileSync(registryPath(), "[]");
	let debounce = null;
	const watcher = watch(registryPath(), () => {
		clearTimeout(debounce);
		debounce = setTimeout(broadcast, 100);
	});

	const server = createServer((req, res) => {
		const url = new URL(req.url, `http://localhost:${port}`);
		const path = decodeURIComponent(url.pathname);
		if (req.method === "OPTIONS") {
			res.writeHead(204, CORS);
			return res.end();
		}
		if (path === "/" || path === "/index.html") {
			res.writeHead(200, { ...CORS, "Content-Type": "text/html; charset=utf-8" });
			return res.end(GALLERY);
		}
		if (path === "/api/artifacts") {
			return sendJson(res, 200, withUrls(listArtifacts(), port));
		}
		if (path === "/api/status") {
			const session = readSession();
			const editorBase = process.env.OPENCUT_URL ?? "http://localhost:3000";
			return sendJson(res, 200, {
				work_folder: loadConfig().work_folder,
				editor_base: editorBase,
				project_id: session?.project_id ?? null,
				editor_url: session?.project_id ? `${editorBase}/editor/${session.project_id}` : null,
				session,
			});
		}
		if (path === "/events") {
			res.writeHead(200, {
				...CORS,
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.write(": connected\n\n");
			clients.add(res);
			req.on("close", () => clients.delete(res));
			return;
		}
		if (path === "/editor" || path.startsWith("/editor/")) {
			const editorBase = process.env.OPENCUT_URL ?? "http://localhost:3000";
			const id = path.split("/")[2] || readSession()?.project_id;
			res.writeHead(302, { ...CORS, Location: id ? `${editorBase}/editor/${id}` : `${editorBase}/projects` });
			return res.end();
		}
		const match = path.match(/^\/a\/([^/]+)(?:\/|$)/);
		if (match) {
			const artifact = listArtifacts().find((a) => a.id === match[1]);
			if (!artifact || !existsSync(artifact.path)) {
				return sendJson(res, 404, { error: "Not found" });
			}
			return sendFile(req, res, artifact.path);
		}
		sendJson(res, 404, { error: "Not found" });
	});

	return new Promise((ok, fail) => {
		server.once("error", (error) => {
			watcher.close();
			fail(error);
		});
		server.listen(port, () => {
			ok({
				port,
				url: `http://localhost:${port}`,
				broadcast,
				close: () => {
					watcher.close();
					for (const res of clients) res.end();
					server.close();
				},
			});
		});
	});
}

/** True when something already answers on the port (e.g. a standalone server). */
export async function isServing(port = loadConfig().server_port) {
	try {
		const res = await fetch(`http://localhost:${port}/api/status`, {
			signal: AbortSignal.timeout(1500),
		});
		return res.ok;
	} catch {
		return false;
	}
}

const isMain =
	process.argv[1] &&
	resolve(fileURLToPath(import.meta.url)).toLowerCase() ===
		resolve(process.argv[1]).toLowerCase();
if (isMain) {
	const flag = process.argv.indexOf("--port");
	const port = flag > 0 ? Number(process.argv[flag + 1]) : loadConfig().server_port || 8787;
	const { url } = await startServer({ port });
	console.log(`OpenCut media server on ${url} (work folder: ${loadConfig().work_folder})`);
	console.log(`registry: ${registryPath()} · ${basename(registryPath())} changes push to /events`);
}
