// Remote control relay: lets a backend send commands to an OpenCut editor page
// open anywhere (e.g. a panel in another app). The page subscribes over SSE and
// posts results back; callers POST commands and long-poll for the answer.
//
//   page:    GET  /control/editor?token=&project=   (SSE stream of commands)
//            POST /control/result?token=            {id, ok, result | error}
//   caller:  POST /control/call?token=              {method, args} -> {done, ...}
//            GET  /control/wait?token=&id=          -> {done, ...}
//            GET  /control/editors?token=           -> connected editors
//            GET  /control/file?token=&path=        a local file, for imports
//
// Calls answer within ~25 s with {done: false, id} if the page is still
// working, so long exports never hit HTTP timeouts; callers then poll /wait.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { workPath } from "./config.mjs";

const POLL_MS = 25_000;
const KEEPALIVE_MS = 15_000;

/** Shared secret for the relay, created once per work folder. */
export function controlToken() {
	const path = workPath("control-token");
	if (existsSync(path)) return readFileSync(path, "utf8").trim();
	const token = randomBytes(24).toString("hex");
	writeFileSync(path, token);
	return token;
}

/** URL to load in a panel so the editor connects to this relay. */
export function panelEditorUrl({ editorBase, serverUrl, projectId }) {
	const url = new URL(`/editor/${projectId ?? ""}`, editorBase);
	url.searchParams.set("control", serverUrl);
	url.searchParams.set("token", controlToken());
	return url.toString();
}

function readBody(req) {
	return new Promise((ok, fail) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
		req.on("error", fail);
	});
}

export function createControlRelay({ cors, sendJson, sendFile }) {
	const editors = new Map(); // connection id -> { res, projectId, connectedAt }
	const calls = new Map(); // call id -> { editorId, result, waiters }

	const finish = (id, result) => {
		const call = calls.get(id);
		if (!call || call.result) return;
		call.result = { done: true, ...result };
		for (const waiter of call.waiters) waiter(call.result);
		call.waiters = [];
		// Keep the answer briefly for a caller that is between polls.
		setTimeout(() => calls.delete(id), 60_000).unref();
	};

	const wait = (id) =>
		new Promise((ok) => {
			const call = calls.get(id);
			if (!call) return ok({ done: true, ok: false, error: `Unknown call ${id}` });
			if (call.result) return ok(call.result);
			const timer = setTimeout(() => {
				call.waiters = call.waiters.filter((w) => w !== done);
				ok({ done: false, id });
			}, POLL_MS);
			const done = (result) => {
				clearTimeout(timer);
				ok(result);
			};
			call.waiters.push(done);
		});

	const latestEditor = () =>
		[...editors.entries()].sort((a, b) => b[1].connectedAt - a[1].connectedAt)[0];

	const listEditors = () =>
		[...editors.entries()].map(([id, e]) => ({
			id,
			project_id: e.projectId,
			connected_at: new Date(e.connectedAt).toISOString(),
		}));

	/** Returns true when the request was a /control route. */
	async function handle(req, res, url) {
		if (!url.pathname.startsWith("/control/")) return false;
		if (url.searchParams.get("token") !== controlToken()) {
			sendJson(res, 403, { error: "Bad or missing token" });
			return true;
		}
		const route = url.pathname.slice("/control/".length);

		if (route === "editor") {
			const id = randomUUID();
			res.writeHead(200, {
				...cors,
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.write(": connected\n\n");
			const keepalive = setInterval(() => res.write(": ping\n\n"), KEEPALIVE_MS);
			editors.set(id, {
				res,
				projectId: url.searchParams.get("project"),
				connectedAt: Date.now(),
			});
			req.on("close", () => {
				clearInterval(keepalive);
				editors.delete(id);
				for (const [callId, call] of calls) {
					if (call.editorId === id) {
						finish(callId, { ok: false, error: "Editor disconnected before answering" });
					}
				}
			});
			return true;
		}

		if (route === "result" && req.method === "POST") {
			const reply = JSON.parse(await readBody(req));
			finish(reply.id, { ok: reply.ok, result: reply.result, error: reply.error });
			sendJson(res, 200, { ok: true });
			return true;
		}

		if (route === "call" && req.method === "POST") {
			const { method, args } = JSON.parse(await readBody(req));
			const target = latestEditor();
			if (!target) {
				sendJson(res, 409, { error: "No editor connected" });
				return true;
			}
			const id = randomUUID();
			calls.set(id, { editorId: target[0], result: null, waiters: [] });
			target[1].res.write(`data: ${JSON.stringify({ id, method, args })}\n\n`);
			sendJson(res, 200, await wait(id));
			return true;
		}

		if (route === "wait") {
			sendJson(res, 200, await wait(url.searchParams.get("id")));
			return true;
		}

		if (route === "editors") {
			sendJson(res, 200, listEditors());
			return true;
		}

		if (route === "file") {
			const path = url.searchParams.get("path");
			if (!path || !existsSync(path)) {
				sendJson(res, 404, { error: "Not found" });
			} else {
				sendFile(req, res, path);
			}
			return true;
		}

		sendJson(res, 404, { error: "Not found" });
		return true;
	}

	return {
		handle,
		listEditors,
		close: () => {
			for (const { res } of editors.values()) res.end();
		},
	};
}
