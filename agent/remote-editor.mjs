// Drives an editor page that connected to the media server's control relay
// (see control.mjs), e.g. a panel in another app. Same interface as launch()
// in opencut.mjs, minus the browser.
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { bridgeApi } from "./opencut.mjs";
import { controlToken } from "./control.mjs";

async function request(serverUrl, route, { params = {}, body } = {}) {
	const url = new URL(`/control/${route}`, serverUrl);
	url.searchParams.set("token", controlToken());
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	const res = await fetch(url, {
		method: body === undefined ? "GET" : "POST",
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = await res.json();
	if (!res.ok) throw new Error(data.error ?? `Relay error ${res.status}`);
	return data;
}

/** Editors currently connected to the relay, newest last. */
export async function connectedEditors(serverUrl) {
	try {
		return await request(serverUrl, "editors");
	} catch {
		return [];
	}
}

export function connectRemote({ serverUrl, timeoutMs = 180_000 }) {
	const call = async (method, args) => {
		let reply = await request(serverUrl, "call", { body: { method, args } });
		while (!reply.done) {
			reply = await request(serverUrl, "wait", { params: { id: reply.id } });
		}
		if (!reply.ok) throw new Error(reply.error);
		return reply.result;
	};

	const closeListeners = [];

	return {
		...bridgeApi(call),
		remote: true,
		logs: [],

		/** Navigates the panel to a project and waits for it to reconnect. */
		async openProject(id) {
			const before = new Set((await connectedEditors(serverUrl)).map((e) => e.id));
			await call("navigate", { projectId: id ?? randomUUID() });
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const editors = await connectedEditors(serverUrl);
				if (editors.some((e) => !before.has(e.id))) return;
				await new Promise((ok) => setTimeout(ok, 300));
			}
			throw new Error("The editor panel did not come back after switching projects");
		},

		/** The page downloads each file from the relay and imports it. */
		importFiles(paths) {
			const files = paths.map((path) => {
				const url = new URL("/control/file", serverUrl);
				url.searchParams.set("token", controlToken());
				url.searchParams.set("path", resolve(path));
				return { url: url.toString(), name: basename(path) };
			});
			return call("importUrls", { files });
		},

		onClose: (listener) => closeListeners.push(listener),
		// The panel belongs to the user's app; closing only detaches.
		close: async () => {
			for (const listener of closeListeners) listener();
		},
	};
}
